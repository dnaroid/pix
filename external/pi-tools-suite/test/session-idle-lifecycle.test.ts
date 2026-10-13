import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSessionChunkSync } from "../src/project-search/semantic-session-chunks.js";
import { SessionIdlePolicy, SESSION_IDLE_MS } from "../src/project-search/session-idle.mjs";
import { SessionChunkSync } from "../src/project-search/session-chunk-sync.mjs";
import { SessionCandidateCatalog } from "../src/project-search/session-discovery.mjs";
import { Database } from "bun:sqlite";
import { writeSourcePolicy } from "../src/project-search/source-policy.mjs";

test("activity during startup persistence is observed before the first indexing pass", async () => {
  const base = resolve(".pi/artifacts/session-idle-lifecycle");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  const candidate = { id: "session", path: join(root, "session.jsonl") };
  await writeFile(candidate.path, "");
  const old = new Date(Date.now() - SESSION_IDLE_MS - 1000);
  await utimes(candidate.path, old, old);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  const original = SessionIdlePolicy.prototype.observe;
  let first = true;
  const observe = spyOn(SessionIdlePolicy.prototype, "observe").mockImplementation(async function (
    this: SessionIdlePolicy, id, running, touch,
  ) {
    await original.call(this, id, running, touch);
    if (first) { first = false; entered(); await paused; }
  });
  type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
  const handlers = new Map<string, Handler>();
  registerSessionChunkSync({ on: (name: string, fn: Handler) => {
    handlers.set(name, fn);
  } } as unknown as ExtensionAPI);
  const ctx = { cwd: root, isIdle: () => true, sessionManager: { getSessionId: () => candidate.id } } as unknown as ExtensionContext;
  const other = new SessionIdlePolicy(root);
  const starting = handlers.get("session_start")!({}, ctx);
  try {
    await started;
    await handlers.get("agent_start")!({}, ctx);
    expect(await other.eligible(candidate, new AbortController().signal)).toBe(false);
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
    release(); await starting;
    observe.mockRestore(); await other.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("extension background uses metadata discovery and skips corpus scans, unchanged revisions and Continue", async () => {
  const base=resolve(".pi/artifacts/session-idle-lifecycle");await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,"metadata-"));
  await writeSourcePolicy(root,"sessions",true);
  const candidates=["old","running","recent"].map(id=>({id,path:join(root,`${id}.jsonl`)}));
  for(const c of candidates) {
    await writeFile(c.path,[{type:"session",id:c.id,cwd:root},
      {type:"message",id:"m",parentId:null,message:{role:"user",content:`Message ${c.id}`}}].map(r=>JSON.stringify(r)).join("\n")+"\n");
    if(c.id!=="recent") {const old=new Date(Date.now()-SESSION_IDLE_MS-1000);await utimes(c.path,old,old);}
  }
  let sync:SessionChunkSync|undefined;
  const changed=spyOn(SessionChunkSync.prototype,"changed").mockImplementation(function(this:SessionChunkSync){sync=this;});
  const start=spyOn(SessionChunkSync.prototype,"start").mockImplementation(()=>{});
  const full=spyOn(SessionManager,"list").mockImplementation(async()=>{throw new Error("Background must not parse the corpus");});
  const list=spyOn(SessionCandidateCatalog.prototype,"list").mockImplementation(async()=>candidates);
  const other=new SessionIdlePolicy(root);await other.observe("running",true,false);
  type Handler=(event:unknown,ctx:ExtensionContext)=>Promise<void>;
  const handlers=new Map<string,Handler>();
  registerSessionChunkSync({on:(name:string,fn:Handler)=>{handlers.set(name,fn);}} as unknown as ExtensionAPI,
    {loadConfig:async()=>undefined});
  const ctx={cwd:root,isIdle:()=>true,sessionManager:{getSessionId:()=>"current"}} as unknown as ExtensionContext;
  try {
    await handlers.get("session_start")!({},ctx);
    const run=()=> (sync as unknown as {run(s:AbortSignal):Promise<void>}).run(new AbortController().signal);
    await run();await run();
    expect(full).toHaveBeenCalledTimes(0);expect(list).toHaveBeenCalledTimes(2);
    const db=new Database(join(root,".pi/search/sessions.sqlite"));
    try {
      expect(db.query("SELECT session_id FROM pix_session_chunk_meta").all()).toEqual([{session_id:"old"}]);
      db.exec("UPDATE pix_search_work SET failures=2,expires=0");
      await run();expect(list).toHaveBeenCalledTimes(2);
    } finally {db.close();}
  } finally {
    await handlers.get("session_shutdown")!({},ctx);await other.dispose();
    changed.mockRestore();start.mockRestore();full.mockRestore();list.mockRestore();
    await rm(root,{recursive:true,force:true});
  }
});
