import { z } from "zod";
import type { Runtime } from "./runtimeOps.js";
import type { Tasks } from "./taskOps.js";
import type { WorkspaceManager } from "./guard.js";

export const EXECUTION_TOOLS = ["start_job", "open_shell", "shell_exec"];
export const TASK_WRITE_TOOLS = ["create_task", "checkpoint_task", "finish_task"];
export const RUNTIME_TOOLS = [...EXECUTION_TOOLS, ...TASK_WRITE_TOOLS, "get_job", "job_logs", "cancel_job", "shell_read", "close_shell", "get_task", "resume_task", "task_context"];

export function registerRuntimeTools(runtime: Runtime, tasks: Tasks, workspaces: WorkspaceManager,
  register: (name: string, options: Record<string, unknown>, handler: (args: any) => unknown) => void) {
  const workspace = { workspace_id: z.string().optional() };
  const session = { session_id: z.string().optional().describe("Existing server bash session label, when required.") };
  const job = { ...workspace, job_id: z.string() };
  const shell = { ...workspace, shell_id: z.string() };
  const task = { ...workspace, task_id: z.string() };
  const descriptions: Record<string, string> = {
    start_job: "Start a durable background Bash command and return immediately. Uses the existing bash policy. Read its status and bounded logs with get_job/job_logs.",
    get_job: "Read persisted job state. A running job from an earlier server process is lost, never inferred successful from its PID.",
    job_logs: "Read one output stream by byte offset, or omit offset for a bounded tail. Returns next_offset and truncation.",
    cancel_job: "Terminate the process tree of a job owned by this server. Lost PIDs are never signalled.",
    open_shell: "Open a workspace-bound persistent Bash subprocess (no PTY). At most eight open shells. Shells do not survive server restart.",
    shell_exec: "Send a command to an idle persistent shell; returns immediately. Use shell_read until idle. Literal cd is guarded; export/source require full Bash policy. cwd and environment persist.",
    shell_read: "Read bounded retained stdout/stderr and the current persistent shell status.",
    close_shell: "Close the persistent shell and its process tree.",
    create_task: "Create a recovery task and plan under the existing .ai-bridge/tasks directory.",
    get_task: "Read saved task metadata and latest checkpoint.",
    checkpoint_task: "Save progress, decisions, remaining work, test results, current Git state and related jobs/shell. Does not copy chat history.",
    resume_task: "Read a task with fresh Git, job, shell, AGENTS and handoff context. Does not execute work or change branches.",
    finish_task: "Mark a task completed or cancelled, preserving its checkpoint history.",
    task_context: "One-call recovery context: active task, checkpoint, AGENTS, branch/HEAD, Git summary, jobs, shells, handoff, tests and remaining work. No full diff."
  };
  const add = (name: string, inputSchema: Record<string, z.ZodTypeAny>, run: (args: any) => unknown) => {
    const readOnly = ["get_job", "job_logs", "shell_read", "get_task", "resume_task", "task_context"].includes(name);
    register(name, { title: name.replaceAll("_", " "), description: descriptions[name], inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: EXECUTION_TOOLS.includes(name), idempotentHint: readOnly } }, run);
  };
  const ws = (args: any) => workspaces.getWorkspace(args.workspace_id);
  add("start_job", { ...workspace, ...session, command: z.string().min(1).max(30000), cwd: z.string().optional() }, a => runtime.startJob(ws(a), a.command, a.cwd, a.session_id));
  add("get_job", job, a => runtime.getJob(ws(a), a.job_id));
  add("job_logs", { ...job, stream: z.enum(["stdout", "stderr"]).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(30000).optional() }, a => runtime.jobLogs(ws(a), a.job_id, a.stream, a.offset, a.limit));
  add("cancel_job", job, a => runtime.cancelJob(ws(a), a.job_id));
  add("open_shell", { ...workspace, ...session, cwd: z.string().optional() }, a => runtime.openShell(ws(a), a.cwd, a.session_id));
  add("shell_exec", { ...shell, ...session, command: z.string().min(1).max(30000) }, a => runtime.execShell(ws(a), a.shell_id, a.command, a.session_id));
  add("shell_read", shell, a => runtime.readShell(ws(a), a.shell_id));
  add("close_shell", shell, a => runtime.closeShell(ws(a), a.shell_id));
  add("create_task", { ...workspace, title: z.string().min(1).max(300), goal: z.string().min(1).max(16000), plan: z.string().max(60000).default("") }, a => tasks.create(ws(a), a.title, a.goal, a.plan));
  add("get_task", task, a => tasks.get(ws(a), a.task_id));
  const list = z.array(z.string().max(2000)).max(100).default([]);
  add("checkpoint_task", { ...task, checkpoint: z.object({ summary: z.string().max(4000), completed: list, remaining: list, decisions: list,
    tests: z.record(z.string().max(2000)).default({}), known_issues: list }), related_jobs: z.array(z.string()).max(100).optional(), related_shell: z.string().nullable().optional() },
    a => tasks.checkpoint(ws(a), a.task_id, a.checkpoint, a.related_jobs, a.related_shell));
  add("finish_task", { ...task, status: z.enum(["completed", "cancelled"]).default("completed") }, a => tasks.finish(ws(a), a.task_id, a.status));
  add("resume_task", task, a => tasks.context(ws(a), a.task_id));
  add("task_context", { ...workspace, target_path: z.string().optional() }, a => tasks.context(ws(a), undefined, a.target_path));
}
