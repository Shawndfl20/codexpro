# Local runtime and task recovery

Runtime tools are available in `standard` and `full` tool mode. Existing `bash`, file, Git and handoff tools keep their behavior. No additional dependency or database is required.

## Background jobs

Use `start_job({workspace_id, command: "npm run check", cwd: "."})`. It returns a stable `job_id` immediately. Poll `get_job({workspace_id, job_id})`; read `job_logs({workspace_id, job_id, stream: "stdout", offset: 0})` and repeat with `next_offset`. Omit `offset` for the latest tail. Select `stderr` separately. Each response is capped at 30 KB or the configured output limit, whichever is smaller. The response reports truncation. `cancel_job` terminates a job owned by the current server, using the same process-tree termination as `bash`.

Jobs store `<job-id>.json`, `<job-id>.stdout.log` and `<job-id>.stderr.log` under `$CODEXPRO_HOME/jobs` (default `~/.codexpro/jobs`). JSON updates use a temporary file and rename. Logs stream directly to file descriptors, so long output is not retained in server memory or limited by an MCP request. Logs remain local until explicitly read and are redacted on tool output; local log files may contain sensitive command output.

Jobs survive MCP session disconnects and server exit while the machine remains running. Completed metadata survives restart. A job still recorded as running by a previous server is reported as `lost`: its process may still be executing, but this server cannot establish its identity or exit status. It never guesses success or kills a recovered PID. Read its saved logs and inspect the local process before deciding to run the command again. Recovery lists show the latest 100 jobs; older jobs remain available by ID.

## Persistent Bash

`open_shell({workspace_id, cwd: "."})` returns a `shell_id`. Send one command at a time with `shell_exec`; poll `shell_read` until `status` is `idle` before sending the next command. The response includes the command's exit code and bounded retained stdout/stderr. `close_shell` terminates the shell and its process tree.

Commands execute in the same ordinary Bash subprocess, preserving cwd and environment. For example, in trusted `bashMode=full`:

```text
shell_exec(shell_id, "cd src")
shell_exec(shell_id, "export EXAMPLE=value")
shell_exec(shell_id, "printf '%s' \"$EXAMPLE\"")
```

Use a separate literal `cd` command. Its target is checked through `PathGuard`, including workspace containment, blocked paths and symlinks. Environment setup such as `export`, PATH changes and sourcing a workspace venv activation script requires full mode, just as it does with `bash`. There are at most eight open shells. Graceful server shutdown closes them; shell sessions are not reattached after restart. No PTY, ConPTY, interactive TUI or terminal resize is provided. Windows uses the existing Bash executable resolution (Git Bash must be on the server's PATH).

Both execution APIs use the existing command policy, restricted environment and optional required `session_id`. `bashMode=off` hides execution tools; connection-test mode disables mutations. As with existing `bash`, safe mode trusts allowlisted repository scripts, and full mode executes trusted arbitrary local code. These policies are **not an OS filesystem sandbox**: a trusted script or full-mode command can access what the OS user can access. Do not enable execution for untrusted repositories. The guarded `cwd` parameter does not sandbox code launched by the shell.

## Recovery tasks

`create_task({workspace_id, title, goal, plan})` creates:

```text
.ai-bridge/tasks/<task-id>/
  task.json
  plan.md
  checkpoints.jsonl
  execution.log
```

The configured `CODEXPRO_CONTEXT_DIR` replaces `.ai-bridge` when customized. Task writes honor `writeMode`: enabled in workspace/handoff mode and disabled in off/connection-test mode. The existing current plan and agent handoff files are not overwritten.

Use `checkpoint_task` with a `checkpoint` containing `summary`, `completed`, `remaining`, `decisions`, `tests` (command/result pairs) and `known_issues`. Optionally associate `related_jobs` and `related_shell`. Branch, HEAD and changed file summaries are captured from Git. Test results are the caller's recorded evidence; job exit codes remain separate runtime observations.

`get_task` reads saved state. `resume_task({workspace_id, task_id})` returns that task with fresh Git, job and shell state, the latest checkpoint, applicable AGENTS instructions and bounded handoff excerpts. It does not switch branches or execute remaining work. `task_context({workspace_id, target_path})` selects the most recently updated active task and returns the same recovery context in one call. Checkpoint branch/HEAD remain distinct from current Git state. Use existing `show_changes` for the full diff. `finish_task` marks the task completed or cancelled without deleting its history. No conversation transcript is copied.

Workspace registration and runtime resources are shared across HTTP MCP sessions; each session keeps its own current workspace selection. After a server restart, call `open_workspace` again for a nonconfigured nested workspace, then use its stable ID to recover saved tasks/jobs.

## Runtime Console

With the existing HTTP server running, open `http://127.0.0.1:8787/runtime` (replace the port if configured). It uses the same server token as `/setup`; an initial local URL may include `?codexpro_token=YOUR_EXISTING_TOKEN`. The page removes the token from the visible URL and keeps it in tab session storage for authenticated requests. Do not share token-bearing URLs.

The Console is local only, rejects forwarded requests and cross-origin access, and is not exposed through the public tunnel. It polls the existing runtime state every three seconds. It shows workspaces, active task/checkpoint, jobs, shells, Git changes, validation and agent/handoff notes. Buttons read stdout/stderr, cancel a job and close a shell. It is an observation surface, not another source of task state. Mutations are unavailable in minimal/connection-test mode.

For stdio users, job/shell/task tools are available without HTTP; the Console is served by the HTTP process and displays the shells owned by that process. Run the HTTP transport when you need both MCP and the Console over the same live runtime.

## Verification

`npm run build` and `node scripts/runtime-smoke.mjs` exercise real local subprocesses and HTTP MCP sessions: command completion/failure, exit codes, both log streams, bounded reads, cancellation, reconnect/restart semantics, policy checks, persistent environment/cwd, checkpoint recovery, and authenticated Console routes/actions. This smoke test is part of the existing `npm run smoke`; no new QA pipeline is added.
