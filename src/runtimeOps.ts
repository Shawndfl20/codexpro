import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { CodexProConfig } from "./config.js";
import { CodexProError, PathGuard, type Workspace } from "./guard.js";
import { assertBashSession, assertSafeCommand, bashExecutable, makeRestrictedBashEnv, terminateProcessTree } from "./bashOps.js";
import { codexProHome } from "./profileStore.js";
import { redactSensitiveText } from "./redact.js";

type Job = {
  job_id: string; workspace_id: string; root: string; command: string; cwd: string;
  pid: number | null; status: "running" | "completed" | "failed" | "cancelled" | "lost";
  started_at: string; finished_at: string | null; exit_code: number | null; owner: string;
  cancel_requested?: boolean;
};
type ClosedShellSummary = Pick<Shell, "shell_id" | "workspace_id" | "cwd" | "pid" | "exit_code" | "stdout" | "stderr" | "truncated"> & {
  status: "closed"; closed_at: string;
};
type Shell = {
  shell_id: string; workspace_id: string; cwd: string; pid: number | null;
  status: "idle" | "running" | "closed"; exit_code: number | null;
  child: ChildProcess; stdout: string; stderr: string; truncated: boolean;
  marker?: string; pending: string; pendingCwd?: string;
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class Runtime {
  private readonly owner = randomUUID();
  private readonly jobsDir = path.join(codexProHome(), "jobs");
  private readonly children = new Map<string, { child: ChildProcess; job: Job }>();
  private readonly shells = new Map<string, Shell>();
  private readonly closedShells = new Map<string, ClosedShellSummary>();
  private readonly guard: PathGuard;
  constructor(private readonly config: CodexProConfig) { this.guard = new PathGuard(config); }

  private jobPath(id: string, suffix = "json") {
    if (!/^job_[a-f0-9-]{36}$/.test(id)) throw new CodexProError("Invalid job_id.");
    return path.join(this.jobsDir, `${id}.${suffix}`);
  }
  private save(job: Job) {
    const file = this.jobPath(job.job_id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(job, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  getJob(workspace: Workspace, id: string) {
    const job: Job = JSON.parse(fs.readFileSync(this.jobPath(id), "utf8"));
    if (job.workspace_id !== workspace.id || job.root !== workspace.root) throw new CodexProError("Job belongs to another workspace.");
    if (job.status === "running" && job.owner !== this.owner) {
      // Never signal a recovered PID: its identity cannot be established after restart.
      job.status = "lost";
      this.save(job);
    }
    const { owner, root, ...publicJob } = job;
    return { ...publicJob, duration: (Date.parse(job.finished_at ?? new Date().toISOString()) - Date.parse(job.started_at)) / 1000 };
  }
  listJobs(workspace: Workspace) {
    if (!fs.existsSync(this.jobsDir)) return [];
    return fs.readdirSync(this.jobsDir).filter(name => /^job_[a-f0-9-]{36}\.json$/.test(name))
      .map(name => JSON.parse(fs.readFileSync(path.join(this.jobsDir, name), "utf8")) as Job)
      .filter(job => job.workspace_id === workspace.id && job.root === workspace.root)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, 100).map(job => this.getJob(workspace, job.job_id));
  }
  private authorize(workspace: Workspace, command: string, cwd: string, sessionId?: string) {
    if (this.config.connectionTest) throw new CodexProError("Execution disabled in connection test mode.");
    if (!command.trim()) throw new CodexProError("command is required.");
    assertBashSession(this.config, sessionId);
    assertSafeCommand(this.config, command);
    return this.guard.resolve(workspace, cwd);
  }
  async startJob(workspace: Workspace, command: string, cwd = ".", sessionId?: string) {
    const resolved = this.authorize(workspace, command, cwd, sessionId);
    fs.mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    const job: Job = { job_id: `job_${randomUUID()}`, workspace_id: workspace.id, root: workspace.root,
      command, cwd: resolved.relPath, pid: null, status: "running", started_at: new Date().toISOString(),
      finished_at: null, exit_code: null, owner: this.owner };
    const out = fs.openSync(this.jobPath(job.job_id, "stdout.log"), "w", 0o600);
    const err = fs.openSync(this.jobPath(job.job_id, "stderr.log"), "w", 0o600);
    let child: ChildProcess;
    try {
      child = spawn(bashExecutable(), ["-lc", command], { cwd: resolved.absPath, env: makeRestrictedBashEnv(this.config),
        stdio: ["ignore", out, err], detached: true, windowsHide: true });
    } finally { fs.closeSync(out); fs.closeSync(err); }
    job.pid = child.pid ?? null;
    this.save(job);
    this.children.set(job.job_id, { child, job });
    child.on("error", error => {
      fs.appendFileSync(this.jobPath(job.job_id, "stderr.log"), error.message);
      job.status = "failed";
    });
    child.on("close", code => {
      this.children.delete(job.job_id);
      if (job.status === "running") job.status = code === 0 ? "completed" : job.cancel_requested ? "cancelled" : "failed";
      job.finished_at = new Date().toISOString(); job.exit_code = code;
      this.save(job);
    });
    child.unref();
    return this.getJob(workspace, job.job_id);
  }
  jobLogs(workspace: Workspace, id: string, stream: "stdout" | "stderr" = "stdout", offset?: number, limit = 16000) {
    this.getJob(workspace, id);
    const file = this.jobPath(id, `${stream}.log`);
    const size = fs.statSync(file).size;
    const max = Math.min(Math.max(1, limit), this.config.maxOutputBytes, 30000);
    const start = Math.min(size, Math.max(0, offset ?? size - max));
    const data = Buffer.alloc(Math.min(max, size - start));
    const fd = fs.openSync(file, "r");
    let bytes: number;
    try { bytes = fs.readSync(fd, data, 0, data.length, start); } finally { fs.closeSync(fd); }
    return { job_id: id, stream, text: redactSensitiveText(data.subarray(0, bytes).toString("utf8")),
      offset: start, next_offset: start + bytes, size, truncated: start > 0 || start + bytes < size };
  }
  cancelJob(workspace: Workspace, id: string, sessionId?: string) {
    assertBashSession(this.config, sessionId);
    const job = this.getJob(workspace, id);
    if (job.status !== "running") return job;
    const owned = this.children.get(id);
    if (!owned) throw new CodexProError("Job process identity is unavailable; cannot cancel.");
    if (owned.child.exitCode === null && owned.child.signalCode === null && !owned.job.cancel_requested
      && terminateProcessTree(owned.child, "SIGKILL")) {
      owned.job.cancel_requested = true;
      this.save(owned.job);
    }
    return this.getJob(workspace, id);
  }
  openShell(workspace: Workspace, cwd = ".", sessionId?: string) {
    const resolved = this.authorize(workspace, "pwd", cwd, sessionId);
    if ([...this.shells.values()].filter(s => s.status !== "closed").length >= 8) throw new CodexProError("Maximum of 8 open shells reached. Close a shell first.");
    const child = spawn(bashExecutable(), ["--noprofile", "--norc"], { cwd: resolved.absPath,
      env: makeRestrictedBashEnv(this.config), stdio: "pipe", detached: process.platform !== "win32", windowsHide: true });
    const shell: Shell = { shell_id: `shell_${randomUUID()}`, workspace_id: workspace.id, cwd: resolved.relPath,
      pid: child.pid ?? null, status: "idle", exit_code: null, child, stdout: "", stderr: "", truncated: false, pending: "" };
    this.shells.set(shell.shell_id, shell);
    const append = (stream: "stdout" | "stderr", text: string) => {
      shell[stream] += text;
      const max = Math.min(this.config.maxOutputBytes, 30000);
      if (shell[stream].length > max) { shell[stream] = shell[stream].slice(-max); shell.truncated = true; }
    };
    child.stdout!.on("data", chunk => {
      shell.pending += chunk.toString();
      const marker = shell.marker;
      if (marker) {
        const start = shell.pending.indexOf(`\x1e${marker}:`);
        const end = start < 0 ? -1 : shell.pending.indexOf("\x1f", start);
        if (end >= 0) {
          append("stdout", shell.pending.slice(0, start));
          const result = shell.pending.slice(start + marker.length + 2, end);
          shell.exit_code = Number(result); if (shell.status !== "closed") shell.status = "idle"; shell.marker = undefined;
          if (shell.exit_code === 0 && shell.pendingCwd !== undefined) shell.cwd = shell.pendingCwd;
          shell.pendingCwd = undefined;
          shell.pending = shell.pending.slice(end + 1);
        }
      }
      // Retain only enough bytes to recognize a split completion marker.
      const keep = shell.marker ? 100 : 0;
      if (shell.pending.length > keep) { append("stdout", shell.pending.slice(0, shell.pending.length - keep)); shell.pending = shell.pending.slice(shell.pending.length - keep); }
    });
    child.stderr!.on("data", chunk => append("stderr", chunk.toString()));
    child.on("error", error => { append("stderr", error.message); shell.status = "closed"; });
    child.once("close", code => {
      append("stdout", shell.pending);
      const stdout = Buffer.from(shell.stdout).subarray(-4000).toString("utf8");
      const stderr = Buffer.from(shell.stderr).subarray(-4000).toString("utf8");
      this.shells.delete(shell.shell_id);
      this.closedShells.set(shell.shell_id, {
        shell_id: shell.shell_id, workspace_id: shell.workspace_id, cwd: shell.cwd, pid: shell.pid,
        status: "closed", exit_code: code, closed_at: new Date().toISOString(), stdout, stderr,
        truncated: shell.truncated || stdout !== shell.stdout || stderr !== shell.stderr
      });
      if (this.closedShells.size > 32) this.closedShells.delete(this.closedShells.keys().next().value!);
      shell.stdout = ""; shell.stderr = ""; shell.pending = "";
      child.stdout!.removeAllListeners("data"); child.stderr!.removeAllListeners("data");
      child.stdin!.removeAllListeners("error"); child.removeAllListeners("error");
    });
    child.stdin!.on("error", error => { append("stderr", error.message); });
    return this.readShell(workspace, shell.shell_id);
  }
  private shell(workspace: Workspace, id: string) {
    const shell = this.shells.get(id) ?? this.closedShells.get(id);
    if (!shell || shell.workspace_id !== workspace.id) throw new CodexProError("Unknown shell in this workspace; shells are not restored after server restart.");
    return shell;
  }
  execShell(workspace: Workspace, id: string, command: string, sessionId?: string) {
    const shell = this.shell(workspace, id);
    if (!("child" in shell) || shell.status !== "idle") throw new CodexProError("Shell is busy or closed. Read it or close it before executing another command.");
    // Directory changes are literal and resolved by the same guard as bash cwd.
    const cd = command.match(/^cd\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;&|<>`$]+))\s*$/);
    if (cd) {
      this.authorize(workspace, "pwd", shell.cwd, sessionId);
      const target = cd[1] ?? cd[2] ?? cd[3];
      const resolved = this.guard.resolve(workspace, path.resolve(workspace.root, shell.cwd, target));
      if (!fs.statSync(resolved.absPath).isDirectory()) throw new CodexProError("cwd must be a directory.");
      command = `builtin cd -- ${quote(resolved.absPath.replaceAll("\\", "/"))}`;
      shell.pendingCwd = resolved.relPath;
    } else {
      this.authorize(workspace, command, shell.cwd, sessionId);
      if (/\b(cd|pushd|popd)\b/.test(command)) throw new CodexProError("Use a separate literal cd command so the workspace path can be checked.");
    }
    shell.marker = randomUUID(); shell.status = "running";
    shell.child.stdin!.write(`${command}\nprintf '\\036${shell.marker}:%s\\037' "$?"\n`);
    return this.readShell(workspace, id);
  }
  readShell(workspace: Workspace, id: string) {
    const shell = this.shell(workspace, id);
    const { shell_id, workspace_id, cwd, pid, status, exit_code, stdout, stderr, truncated } = shell;
    const result = { shell_id, workspace_id, cwd, pid, status, exit_code, stdout, stderr, truncated,
      ...("closed_at" in shell ? { closed_at: shell.closed_at } : {}) };
    return { ...result, stdout: redactSensitiveText(result.stdout), stderr: redactSensitiveText(result.stderr) };
  }
  listShells(workspace: Workspace) {
    return [...this.shells.values(), ...this.closedShells.values()].filter(s => s.workspace_id === workspace.id).map(s => {
      const { stdout, stderr, ...summary } = this.readShell(workspace, s.shell_id); return summary;
    });
  }
  closeShell(workspace: Workspace, id: string, sessionId?: string) {
    assertBashSession(this.config, sessionId);
    const shell = this.shell(workspace, id);
    if ("child" in shell && shell.status !== "closed") { terminateProcessTree(shell.child, "SIGKILL"); shell.status = "closed"; }
    return this.readShell(workspace, id);
  }
  close() {
    for (const shell of this.shells.values()) if (shell.status !== "closed") {
      terminateProcessTree(shell.child, "SIGKILL"); shell.status = "closed";
    }
  }
}
