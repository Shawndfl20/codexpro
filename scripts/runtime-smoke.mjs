import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../dist/config.js';
import { Runtime } from '../dist/runtimeOps.js';
import { Tasks } from '../dist/taskOps.js';
import { createCodexProServer } from '../dist/server.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceManager } from '../dist/guard.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-runtime-'));
const root = path.join(tmp, 'repo');
await fs.mkdir(path.join(root, 'src'), { recursive: true });
await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { check: 'node check.cjs' } }));
await fs.writeFile(path.join(root, 'check.cjs'), 'console.log("check started");console.error("check stderr");setTimeout(()=>console.log("check passed"),1500);');
await fs.writeFile(path.join(root, 'AGENTS.md'), 'Keep the change focused.');
for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Runtime Test', '-c', 'user.email=runtime@example.invalid', 'commit', '-m', 'fixture']]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}
const env = { ...process.env, CODEXPRO_HOME: path.join(tmp, 'data'), CODEXPRO_ROOT: root, CODEXPRO_ALLOWED_ROOTS: root,
  CODEXPRO_HOST: '127.0.0.1', CODEXPRO_HTTP_TOKEN: 'runtime-smoke-token-abcdefghijklmnopqrstuvwxyz', CODEXPRO_REQUIRE_HTTP_TOKEN: '1',
  CODEXPRO_BASH_MODE: 'full', CODEXPRO_WRITE_MODE: 'workspace', CODEXPRO_TOOL_MODE: 'standard', CODEXPRO_TOOL_CARDS: '0', CODEXPRO_CONNECTION_TEST: '0' };
Object.assign(process.env, env);
const config = loadConfig([]);
const wm = new WorkspaceManager(config); const workspace = wm.defaultWorkspace();
const safe = new Runtime({ ...config, bashMode: 'safe' });
for (const command of ['cat .env', 'git show HEAD:.env', 'ls ../', 'ls .git', 'pwd; cat .env']) {
  await assert.rejects(safe.startJob(workspace, command), /blocked|allowlist/);
}
await assert.rejects(safe.startJob(workspace, 'pwd', '..'), /escapes/);
await assert.rejects(safe.startJob(workspace, 'pwd', '.git'), /blocked/);
await assert.rejects(new Runtime({ ...config, bashMode: 'off' }).startJob(workspace, 'pwd'), /disabled/);
await assert.rejects(new Runtime({ ...config, requireBashSession: true, bashSessionId: 'guard' }).startJob(workspace, 'pwd'), /required/);
const anotherRoot = path.join(root, 'another'); await fs.mkdir(anotherRoot);
const another = wm.openWorkspace(anotherRoot);
const guardedShell = safe.openShell(workspace);
assert.throws(() => safe.execShell(workspace, guardedShell.shell_id, 'export VALUE=no'), /allowlist/);
assert.throws(() => safe.execShell(workspace, guardedShell.shell_id, 'cd .git'), /blocked/);
assert.throws(() => safe.readShell(another, guardedShell.shell_id), /Unknown shell/);
safe.closeShell(workspace, guardedShell.shell_id);
const capped = new Runtime(config);
for (let i=0;i<8;i++) capped.openShell(workspace);
assert.throws(() => capped.openShell(workspace), /Maximum of 8/);
capped.close();
assert.ok(capped.listShells(workspace).every(shell => shell.status === 'closed'));
assert.throws(() => new Tasks({ ...config, writeMode: 'off' }, safe).create(workspace, 'test', 'test', ''), /disabled/);

for (const overrides of [{toolMode:'minimal'},{bashMode:'off'},{writeMode:'off'},{connectionTest:true}]) {
  const server = createCodexProServer({...config,...overrides});
  const connection = new Client({name:'policy-test',version:'1'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await connection.connect(clientTransport);
  const names = (await connection.listTools()).tools.map(tool=>tool.name);
  if(overrides.toolMode === 'minimal' || overrides.bashMode === 'off' || overrides.connectionTest) assert.ok(!names.includes('start_job') && !names.includes('shell_exec'));
  if(overrides.writeMode === 'off' || overrides.connectionTest) assert.ok(!names.includes('checkpoint_task'));
  if(overrides.connectionTest) assert.ok(!names.includes('cancel_job') && !names.includes('close_shell'));
  await connection.close(); await server.close();
}

const freePort = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
env.CODEXPRO_PORT = String(freePort);
env.CODEXPRO_REQUIRE_BASH_SESSION = '1';
env.CODEXPRO_BASH_SESSION_ID = 'runtime-smoke';
const base = `http://127.0.0.1:${freePort}`;
const headers = { Authorization: `Bearer ${env.CODEXPRO_HTTP_TOKEN}` };
let child, client;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, predicate) { const start = Date.now(); let result; do { result = await fn(); if (predicate(result)) return result; await delay(50); } while (Date.now() - start < 15000); throw Error('Timed out: '+JSON.stringify(result)); }
async function boot() {
  child = spawn(process.execPath, ['dist/http.js'], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', data => errors += data);
  await until(async () => { if (child.exitCode !== null) throw Error(errors); try { return (await fetch(base+'/healthz', { headers })).ok; } catch { return false; } }, Boolean);
}
async function connect() {
  client = new Client({ name: 'runtime-smoke', version: '1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'), { requestInit: { headers } }));
}
async function call(name, args = {}) {
  const execution = ['start_job', 'open_shell', 'shell_exec', 'cancel_job', 'close_shell'].includes(name);
  const result = await client.callTool({ name, arguments: { ...(execution ? { session_id: env.CODEXPRO_BASH_SESSION_ID } : {}), ...args } });
  assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent;
}
async function stop() {
  await client?.close(); client = null;
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
}
// Closed history must not retain the live ChildProcess or its output/listeners.
const recycled = new Runtime(config);
let firstClosed;
for (let index=0;index<35;index++) {
  const opened = recycled.openShell(workspace);
  firstClosed ??= opened.shell_id;
  const live = recycled.shells.get(opened.shell_id);
  await once(live.child, 'spawn');
  if (index === 34) {
    recycled.execShell(workspace, opened.shell_id, "printf '%6000s' x");
    await until(() => recycled.readShell(workspace, opened.shell_id), shell => shell.status === 'idle');
  }
  const closed = once(live.child, 'close');
  recycled.closeShell(workspace, opened.shell_id);
  await closed;
  assert.equal(recycled.shells.size, 0);
  assert.equal(live.child.stdout.listenerCount('data'), 0);
  assert.equal(live.child.stderr.listenerCount('data'), 0);
  assert.equal(live.child.listenerCount('error'), 0);
  assert.equal(live.pending, ''); assert.equal(live.stdout, ''); assert.equal(live.stderr, '');
  const summary = recycled.readShell(workspace, opened.shell_id);
  assert.equal(summary.status, 'closed'); assert.ok(summary.closed_at);
  assert.ok(summary.stdout.length <= 4000 && summary.stderr.length <= 4000);
}
assert.equal(recycled.listShells(workspace).length, 32);
assert.throws(() => recycled.readShell(workspace, firstClosed), /Unknown shell/);
const natural = recycled.openShell(workspace);
recycled.execShell(workspace, natural.shell_id, 'exit 3');
assert.equal((await until(() => recycled.readShell(workspace, natural.shell_id), shell => shell.closed_at)).exit_code, 3);
const failedShell = recycled.openShell(workspace, 'missing-directory');
await until(() => recycled.readShell(workspace, failedShell.shell_id), shell => shell.closed_at);
assert.equal(recycled.shells.size, 0);
assert.equal(recycled.listShells(workspace).length, 32);

// Cancel from the actual exit callback, before close finalizes persisted metadata.
const racing = new Runtime(config);
for (const code of [0, 7]) {
  const job = await racing.startJob(workspace, `exit ${code}`);
  const owned = racing.children.get(job.job_id);
  owned.child.ref();
  await new Promise((resolve, reject) => owned.child.once('exit', () => {
    try {
      const result = racing.cancelJob(workspace, job.job_id);
      assert.equal(result.cancel_requested, undefined);
      assert.equal(result.finished_at, null);
      resolve();
    } catch(error) { reject(error); }
  }));
  const result = await until(() => racing.getJob(workspace, job.job_id), job => job.status !== 'running');
  assert.equal(result.status, code === 0 ? 'completed' : 'failed'); assert.equal(result.exit_code, code);
}
await fs.writeFile(path.join(root, 'cancel.cjs'), "require('node:fs').writeSync(1, 'ready'); setTimeout(() => {}, 20000);");
const requested = await racing.startJob(workspace, 'node cancel.cjs');
await until(() => racing.jobLogs(workspace, requested.job_id).text, text => text.includes('ready'));
const cancelling = racing.cancelJob(workspace, requested.job_id);
assert.equal(cancelling.status, 'running'); assert.equal(cancelling.cancel_requested, true, JSON.stringify({cancelling,stderr:racing.jobLogs(workspace,requested.job_id,'stderr').text})); assert.equal(cancelling.finished_at, null);
assert.equal((await until(() => racing.getJob(workspace, requested.job_id), job => job.status !== 'running')).status, 'cancelled');

try {
  await boot(); await connect();
  const started = Date.now(); const job = await call('start_job', { command: 'npm run check' });
  assert.equal(job.status, 'running'); assert.ok(Date.now() - started < 1400, 'start_job must return before check finishes');
  assert.equal((await call('get_job', { job_id: job.job_id })).job_id, job.job_id);
  await client.close(); await connect(); // A different MCP session must retain the same runtime.
  const complete = await until(() => call('get_job', { job_id: job.job_id }), j => j.status !== 'running');
  assert.equal(complete.status, 'completed'); assert.equal(complete.exit_code, 0);
  assert.throws(() => safe.getJob(another, job.job_id), /another workspace/);
  assert.match((await call('job_logs', { job_id: job.job_id, offset: 0 })).text, /check passed/);
  assert.match((await call('job_logs', { job_id: job.job_id, stream: 'stderr' })).text, /check stderr/);
  const limited = await call('job_logs', { job_id: job.job_id, offset: 0, limit: 8 });
  assert.equal(limited.next_offset, 8); assert.equal(limited.truncated, true);
  const bad = await call('start_job', { command: 'exit 7' });
  assert.equal((await until(() => call('get_job', { job_id: bad.job_id }), j => j.status !== 'running')).exit_code, 7);
  const shell = await call('open_shell');
  async function exec(command) { await call('shell_exec', { shell_id: shell.shell_id, command }); return until(() => call('shell_read', { shell_id: shell.shell_id }), s => s.status !== 'running'); }
  await exec('cd src'); await exec('export RUNTIME_VALUE=persisted');
  await fs.writeFile(path.join(root, 'src', 'activate'), 'export VIRTUAL_ENV=local-venv\nexport PATH=.:$PATH\n');
  await exec('source activate');
  const environment = await exec('printf "%s %s" "$VIRTUAL_ENV" "$PATH"');
  assert.match(environment.stdout, /local-venv \.:/);
  const shellResult = await exec('printf "%s %s" "$PWD" "$RUNTIME_VALUE"');
  assert.equal(shellResult.pid, shell.pid); assert.equal(shellResult.cwd, 'src'); assert.match(shellResult.stdout, /src persisted/);
  const escape = await client.callTool({ name: 'shell_exec', arguments: { shell_id: shell.shell_id, command: 'cd ../..', session_id: env.CODEXPRO_BASH_SESSION_ID } }); assert.equal(escape.isError, true);
  const task = await call('create_task', { title: 'Fix onboarding navigation', goal: 'Restore navigation and verify it', plan: 'Change navigation, then run checks.' });
  await fs.writeFile(path.join(root, 'src', 'navigation.txt'), 'updated navigation');
  await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bridge', 'agent-status.md'), 'Navigation updated by local agent.');
  await fs.writeFile(path.join(root, '.ai-bridge', 'execution-log.jsonl'), 'old line\n'.repeat(1000)+'LATEST EXECUTION RESULT\n');
  await fs.writeFile(path.join(root, '.ai-bridge', 'handoff-run-state.json'), '{"status":"completed"}');
  await call('checkpoint_task', { task_id: task.task_id, checkpoint: { summary: 'Navigation fixed', completed: ['navigation'], remaining: ['browser regression'], tests: { 'npm run check': 'passed' } }, related_jobs: [job.job_id], related_shell: shell.shell_id });
  await client.close(); await connect();
  const resumed = await call('resume_task', { task_id: task.task_id });
  assert.equal(resumed.active_task.title, task.title); assert.equal(resumed.head.length, 40); assert.match(resumed.changed_files, /src/);
  assert.equal(resumed.validation['npm run check'], 'passed'); assert.deepEqual(resumed.remaining_work, ['browser regression']);
  assert.match(resumed.handoff.text, /Navigation updated/); assert.match(resumed.handoff.text, /LATEST EXECUTION RESULT/); assert.match(resumed.instructions, /Keep the change focused/);
  assert.equal((await call('task_context')).active_task.task_id, task.task_id);
  assert.equal((await fetch(base+'/runtime')).status, 401);
  const page = await fetch(base+'/runtime', { headers }); assert.match(await page.text(), /CodexPro Runtime/);
  assert.equal((await fetch(base+'/runtime/state', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base+'/runtime/state', { headers: { ...headers, 'X-Forwarded-For': '8.8.8.8' } })).status, 403);
  const running = await call('start_job', { command: 'sleep 20' });
  const schemas = (await client.listTools()).tools;
  for (const [name, id] of [['cancel_job', {job_id:running.job_id}], ['close_shell', {shell_id:shell.shell_id}]]) {
    assert.ok(schemas.find(tool => tool.name === name).inputSchema.properties.session_id);
    for (const session of [{}, {session_id:'wrong'}]) {
      const rejected = await client.callTool({name, arguments:{...id,...session}});
      assert.equal(rejected.isError, true); assert.match(JSON.stringify(rejected), /session id (is required|mismatch)/);
    }
  }
  assert.equal((await call('get_job', {job_id:running.job_id})).status, 'running');
  assert.equal((await call('shell_read', {shell_id:shell.shell_id})).status, 'idle');
  const light = await (await fetch(base+'/runtime/state', {headers})).json();
  assert.ok(light.jobs && light.persistent_shells);
  for (const field of ['tasks','active_task','instructions','git_status','diff_summary','handoff']) assert.ok(!(field in light));
  const state = await (await fetch(base+'/runtime/state?include_context=1', { headers })).json();
  assert.equal(state.active_task.task_id, task.task_id); assert.ok(state.running_jobs.some(j => j.job_id === running.job_id)); assert.equal(state.persistent_shells[0].shell_id, shell.shell_id);
  const cancel = await fetch(base+'/runtime/action', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ action: 'cancel_job', workspace_id: state.workspace.id, id: running.job_id }) });
  assert.equal(cancel.status, 200); await delay(200); assert.equal((await call('get_job', { job_id: running.job_id })).status, 'cancelled');
  await call('close_shell', { shell_id: shell.shell_id }); assert.equal((await call('shell_read', { shell_id: shell.shell_id })).status, 'closed');
  const adminShell = await call('open_shell');
  const adminClose = await fetch(base+'/runtime/action', {method:'POST', headers:{...headers,'Content-Type':'application/json',Origin:base}, body:JSON.stringify({action:'close_shell',workspace_id:state.workspace.id,id:adminShell.shell_id})});
  assert.equal(adminClose.status, 200); assert.equal((await adminClose.json()).status, 'closed');
  const lost = await call('start_job', { command: 'sleep 3; printf survived > survived.txt' });
  await stop(); await boot(); await connect();
  assert.equal((await call('get_job', { job_id: lost.job_id })).status, 'lost');
  assert.equal((await call('cancel_job', { job_id: lost.job_id })).status, 'lost');
  assert.equal((await call('get_job', { job_id: job.job_id })).status, 'completed');
  const restored = await call('resume_task', { task_id: task.task_id }); assert.equal(restored.related_shell.status, 'lost');
  await until(async () => { try { return await fs.readFile(path.join(root, 'survived.txt'), 'utf8'); } catch { return ''; } }, value => value === 'survived');
  await call('finish_task', { task_id: task.task_id }); assert.equal((await call('get_task', { task_id: task.task_id })).status, 'completed');
  console.log('Runtime smoke passed: jobs, cancellation, logs, MCP reconnect, restart/lost, shell state, task recovery, console and policy checks.');
} finally {
  if (child && child.exitCode === null) await stop();
  safe.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
