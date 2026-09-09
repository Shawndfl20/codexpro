import express, { type Express } from "express";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import type { WorkspaceManager } from "./guard.js";
import type { Runtime } from "./runtimeOps.js";
import { Tasks } from "./taskOps.js";
import { redactSensitiveText, redactStructured } from "./redact.js";

export function registerRuntimeConsole(app: Express, config: CodexProConfig, workspaces: WorkspaceManager, runtime: Runtime) {
  const tasks = new Tasks(config, runtime);
  app.use("/runtime", (req, res, next) => {
    const host = req.headers.host ?? "";
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
    if (!local || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)
      || req.headers["x-forwarded-for"] || req.headers["forwarded"]
      || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      res.status(403).json({ error: "Runtime Console is available only on the local origin." }); return;
    }
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    next();
  });
  app.get("/runtime", (_req, res) => res.type("html").send(consoleHtml));
  app.get("/runtime/state", async (req, res) => {
    try {
      const workspace = workspaces.getWorkspace(typeof req.query.workspace_id === "string" ? req.query.workspace_id : undefined);
      const state = req.query.include_context === "1"
        ? { ...(await tasks.context(workspace)), tasks: tasks.list(workspace).slice(0, 30) }
        : { workspace, jobs: runtime.listJobs(workspace), persistent_shells: runtime.listShells(workspace) };
      res.json(redactStructured({ workspaces: workspaces.listWorkspaces(), ...state }));
    } catch (error) { res.status(400).json({ error: redactSensitiveText(String(error)) }); }
  });
  app.get("/runtime/logs", (req, res) => {
    try {
      const query = z.object({ workspace_id: z.string(), job_id: z.string(), stream: z.enum(["stdout", "stderr"]).default("stdout") }).parse(req.query);
      res.json(runtime.jobLogs(workspaces.getWorkspace(query.workspace_id), query.job_id, query.stream));
    } catch (error) { res.status(400).json({ error: redactSensitiveText(String(error)) }); }
  });
  app.post("/runtime/action", express.json({ limit: "4kb" }), (req, res) => {
    try {
      if (config.connectionTest || config.toolMode === "minimal") { res.status(403).json({ error: "Runtime mutations are unavailable in this tool mode." }); return; }
      if (!req.is("application/json")) { res.status(415).end(); return; }
      const body = z.object({ action: z.enum(["cancel_job", "close_shell"]), workspace_id: z.string(), id: z.string() }).strict().parse(req.body);
      const workspace = workspaces.getWorkspace(body.workspace_id);
      res.json(body.action === "cancel_job" ? runtime.cancelJob(workspace, body.id, config.bashSessionId) : runtime.closeShell(workspace, body.id, config.bashSessionId));
    } catch (error) { res.status(400).json({ error: redactSensitiveText(String(error)) }); }
  });
}

const consoleHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodexPro Runtime</title>
<style>
body{font:15px system-ui;background:#f5f6f8;color:#20252d;margin:0}main{max-width:1100px;margin:auto;padding:28px}h1{font-size:28px}h2{font-size:18px;margin:0 0 14px}section{background:white;border:1px solid #dce0e6;border-radius:10px;padding:20px;margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px ui-monospace,monospace;max-height:400px;overflow:auto}.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid #edf0f3;padding:12px 0}.label{flex:1;min-width:130px;overflow-wrap:anywhere}button,select{font:inherit;border:1px solid #bbc3ce;border-radius:6px;background:#fff;padding:7px 12px;cursor:pointer}button:focus-visible,select:focus-visible{outline:3px solid #386be8}small{color:#5a6573}#error{color:#a21c2c}#grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}#grid section{min-width:0;margin:0}@media(max-width:700px){main{padding:16px}#grid{grid-template-columns:1fr}}
</style>
<main><h1>CodexPro Runtime</h1><p>Live workspace activity</p><label>Workspace <select id="workspace"></select></label><p id="error" role="status"></p>
<section><h2>Task / Checkpoint</h2><div id="task"></div></section>
<div id="grid"><section><h2>Jobs</h2><div id="jobs"></div></section><section><h2>Persistent shells</h2><div id="shells"></div></section></div>
<section><h2>Git changes</h2><pre id="git"></pre></section><section><h2>Validation</h2><pre id="validation"></pre></section>
<section><h2>Agent / Handoff</h2><pre id="handoff"></pre></section><section><h2>Job logs</h2><div id="logtitle"></div><pre id="logs">Select stdout or stderr on a job.</pre></section>
<small id="updated"></small></main>
<script>
const params=new URLSearchParams(location.search);let token=params.get('codexpro_token')||params.get('token')||sessionStorage.getItem('codexpro-runtime-token')||'';
if(token)sessionStorage.setItem('codexpro-runtime-token',token);history.replaceState(null,'',location.pathname);
const $=id=>document.getElementById(id);let selected='',logJob=null,contextDue=0;
async function request(url,body){const response=await fetch(url,{headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});if(!response.ok)throw Error(await response.text());return response.json()}
function pre(parent,value){const e=document.createElement('pre');e.textContent=typeof value==='string'?value:JSON.stringify(value,null,2);parent.append(e)}
function button(parent,title,action){const b=document.createElement('button');b.textContent=title;b.onclick=()=>action().catch(e=>$('error').textContent=e.message);parent.append(b)}
async function action(kind,id){await request('/runtime/action',{action:kind,workspace_id:selected,id});await refresh()}
async function logs(id,stream){logJob={id,stream};const data=await request('/runtime/logs?'+new URLSearchParams({workspace_id:selected,job_id:id,stream}));$('logtitle').textContent=id+' / '+stream+(data.truncated?' (tail; earlier output retained on disk)':'');$('logs').textContent=data.text||'(no output)'}
async function refresh(){try{const workspaceId=selected;const deep=Date.now()>=contextDue;const query=new URLSearchParams();if(workspaceId)query.set('workspace_id',workspaceId);if(deep)query.set('include_context','1');const data=await request('/runtime/state?'+query);if(selected!==workspaceId)return;selected=data.workspace.id;
if(deep)contextDue=Date.now()+15000;
const picker=$('workspace');picker.replaceChildren();for(const w of data.workspaces){const o=document.createElement('option');o.value=w.id;o.textContent=w.root;o.selected=w.id===selected;picker.append(o)}
if(deep){$('task').replaceChildren();if(data.active_task){const t=data.active_task;const title=document.createElement('h3');title.textContent=t.title+' — '+t.status;$('task').append(title);const goal=document.createElement('p');goal.textContent=t.goal;$('task').append(goal);if(t.latest_checkpoint){pre($('task'),t.latest_checkpoint.summary+'\\nRemaining: '+(t.latest_checkpoint.remaining.join('; ')||'None recorded'))}const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='View checkpoint and task details';details.append(summary);pre(details,t);$('task').append(details)}else $('task').textContent='No active task.';
for(const t of data.tasks.filter(t=>t.status!=='active')){const d=document.createElement('details');const summary=document.createElement('summary');summary.textContent=t.title+' — '+t.status;d.append(summary);pre(d,t);$('task').append(d)}
$('git').textContent=data.branch+' / '+data.head+'\\n'+data.git_status+'\\n'+data.diff_summary;$('validation').textContent=Object.keys(data.validation).length?JSON.stringify(data.validation,null,2):'No test results recorded.';$('handoff').textContent=data.handoff.text||'No agent handoff recorded.';}
for(const [id,items]of [['jobs',data.jobs],['shells',data.persistent_shells]]){const root=$(id);root.replaceChildren();if(!items.length)root.textContent='None';for(const item of items){const row=document.createElement('div');row.className='row';const label=document.createElement('span');label.className='label';label.textContent=(item.command||item.shell_id)+' — '+item.status;row.append(label);if(id==='jobs'){button(row,'stdout',()=>logs(item.job_id,'stdout'));button(row,'stderr',()=>logs(item.job_id,'stderr'));if(item.status==='running')button(row,'Cancel',()=>action('cancel_job',item.job_id))}else if(item.status!=='closed')button(row,'Close',()=>action('close_shell',item.shell_id));root.append(row)}}
$('error').textContent='';$('updated').textContent='Updated '+new Date().toLocaleTimeString();if(logJob)await logs(logJob.id,logJob.stream)
}catch(e){$('error').textContent=e.message}}
$('workspace').onchange=()=>{selected=$('workspace').value;logJob=null;contextDue=0;refresh()};async function poll(){await refresh();setTimeout(poll,3000)}poll();
</script></html>`;
