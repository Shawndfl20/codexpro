import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexProConfig } from "./config.js";
import { PathGuard, CodexProError, type Workspace } from "./guard.js";
import { gitStatus, gitDiffStatus, runGit } from "./gitOps.js";
import { readCodexContext, readAiBridgeContext } from "./workspaceOps.js";
import { hasSecretValue, redactStructured } from "./redact.js";
import type { Runtime } from "./runtimeOps.js";

export type Checkpoint = {
  summary: string; completed: string[]; remaining: string[]; decisions: string[];
  tests: Record<string, string>; known_issues: string[];
};
type Task = {
  task_id: string; title: string; goal: string; workspace_id: string;
  branch: string; base_commit: string; head: string; status: "active" | "completed" | "cancelled";
  related_jobs: string[]; related_shell: string | null; changed_files: string;
  latest_checkpoint: (Checkpoint & { branch: string; head: string; created_at: string }) | null;
  created_at: string; updated_at: string;
};

export class Tasks {
  private readonly guard: PathGuard;
  constructor(private readonly config: CodexProConfig, private readonly runtime: Runtime) { this.guard = new PathGuard(config); }
  private file(workspace: Workspace, id: string, name = "task.json", write = false) {
    if (!/^task_[a-f0-9-]{36}$/.test(id)) throw new CodexProError("Invalid task_id.");
    return this.guard.resolve(workspace, `${this.config.contextDir}/tasks/${id}/${name}`, { forWrite: write }).absPath;
  }
  private writable() {
    if (this.config.writeMode === "off" || this.config.connectionTest) throw new CodexProError("Task writes are disabled by the current write policy.");
  }
  private save(workspace: Workspace, task: Task, event: string) {
    this.writable();
    const data = JSON.stringify(task, null, 2);
    if (Buffer.byteLength(data) > this.config.maxWriteBytes) throw new CodexProError("Task exceeds maxWriteBytes.");
    if (hasSecretValue(data)) throw new CodexProError("Secret-looking task content is blocked. Use redacted placeholders.");
    const file = this.file(workspace, task.task_id, "task.json", true);
    const tmp = this.file(workspace, task.task_id, "task.json.tmp", true);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data); fs.renameSync(tmp, file);
    fs.appendFileSync(this.file(workspace, task.task_id, "execution.log", true), `${JSON.stringify({ event, at: task.updated_at })}\n`);
  }
  git(workspace: Workspace) {
    return {
      branch: runGit(workspace, ["branch", "--show-current"], 4000),
      head: runGit(workspace, ["rev-parse", "HEAD"], 4000),
      git_status: gitStatus(this.config, workspace, this.guard),
      changed_files: [gitDiffStatus(this.config, this.guard, workspace), gitDiffStatus(this.config, this.guard, workspace, undefined, true)].filter(value => value !== "(no output)").join("\n"),
      diff_summary: runGit(workspace, ["diff", "HEAD", "--stat", "--no-ext-diff", "--no-textconv"], 16000)
    };
  }
  get(workspace: Workspace, id: string): Task {
    const file = this.file(workspace, id);
    if (fs.statSync(file).size > this.config.maxWriteBytes) throw new CodexProError("Task exceeds maxWriteBytes.");
    const task: Task = JSON.parse(fs.readFileSync(file, "utf8"));
    if (task.workspace_id !== workspace.id || task.task_id !== id) throw new CodexProError("Task belongs to another workspace.");
    return task;
  }
  list(workspace: Workspace) {
    const dir = this.guard.resolve(workspace, `${this.config.contextDir}/tasks`).absPath;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(id => /^task_[a-f0-9-]{36}$/.test(id)).map(id => this.get(workspace, id))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  create(workspace: Workspace, title: string, goal: string, plan: string) {
    this.writable();
    if (hasSecretValue(plan) || Buffer.byteLength(plan) > this.config.maxWriteBytes) throw new CodexProError("Plan is too large or contains secret-looking content.");
    const git = this.git(workspace); const now = new Date().toISOString();
    const task: Task = { task_id: `task_${randomUUID()}`, title, goal, workspace_id: workspace.id,
      branch: git.branch, head: git.head, base_commit: git.head, status: "active", related_jobs: [], related_shell: null,
      changed_files: git.changed_files, latest_checkpoint: null, created_at: now, updated_at: now };
    this.save(workspace, task, "created");
    fs.writeFileSync(this.file(workspace, task.task_id, "plan.md", true), plan || goal);
    fs.writeFileSync(this.file(workspace, task.task_id, "checkpoints.jsonl", true), "");
    return task;
  }
  checkpoint(workspace: Workspace, id: string, checkpoint: Checkpoint, jobs?: string[], shell?: string | null) {
    this.writable();
    const task = this.get(workspace, id);
    if (task.status !== "active") throw new CodexProError("Only active tasks can be checkpointed.");
    if (jobs) { jobs.forEach(job => this.runtime.getJob(workspace, job)); task.related_jobs = jobs; }
    if (shell) this.runtime.readShell(workspace, shell);
    if (shell !== undefined) task.related_shell = shell;
    const git = this.git(workspace);
    task.branch = git.branch; task.head = git.head; task.changed_files = git.changed_files;
    task.updated_at = new Date().toISOString();
    task.latest_checkpoint = { ...checkpoint, branch: git.branch, head: git.head, created_at: task.updated_at };
    this.save(workspace, task, "checkpoint");
    fs.appendFileSync(this.file(workspace, id, "checkpoints.jsonl", true), `${JSON.stringify(task.latest_checkpoint)}\n`);
    return task;
  }
  finish(workspace: Workspace, id: string, status: "completed" | "cancelled") {
    const task = this.get(workspace, id);
    task.status = status; task.updated_at = new Date().toISOString();
    this.save(workspace, task, "finished"); return task;
  }
  async context(workspace: Workspace, id?: string, targetPath = ".") {
    const task = id ? this.get(workspace, id) : this.list(workspace).find(t => t.status === "active") ?? null;
    const context = await readCodexContext(this.config, this.guard, workspace,
      { targetPath, includeAiBridge: false, includeGit: false, includeDiff: false, maxAgentBytes: 16000 });
    const bridge = await readAiBridgeContext(this.config, this.guard, workspace, { summary: true });
    const jobs = this.runtime.listJobs(workspace);
    for (const job of task?.related_jobs ?? []) if (!jobs.some(j => j.job_id === job)) jobs.push(this.runtime.getJob(workspace, job));
    const shells = this.runtime.listShells(workspace);
    const relatedShell = task?.related_shell ? shells.find(s => s.shell_id === task.related_shell)
      ?? { shell_id: task.related_shell, status: "lost" } : null;
    return redactStructured({ workspace, ...this.git(workspace), instructions: context.text,
      agents_files: context.agentsFiles, active_task: task, latest_checkpoint: task?.latest_checkpoint ?? null,
      running_jobs: jobs.filter(j => j.status === "running"), jobs, persistent_shells: shells, related_shell: relatedShell,
      handoff: bridge, remaining_work: task?.latest_checkpoint?.remaining ?? [],
      validation: task?.latest_checkpoint?.tests ?? {},
      references: task ? [`${this.config.contextDir}/tasks/${task.task_id}/plan.md`, `${this.config.contextDir}/tasks/${task.task_id}/checkpoints.jsonl`] : [] });
  }
}
