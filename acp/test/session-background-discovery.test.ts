import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DesktopSessionChunks } from "../src/search/session-chunk-service.js";
import { BackgroundSessionDiscovery, hydrateBackgroundTitle } from "../src/search/background-session-discovery.js";
import { nativeSessionDirectory } from "../src/search/session-discovery.js";
import { createSessionIndexTransaction } from "../src/search/session-index.js";
import { SessionIdlePolicy, SESSION_IDLE_MS } from "../src/search/session-idle.js";
import { SearchWorkNeedsContinueError, claimWork } from "../src/search/source-work.js";
import { hashText } from "../src/search/documents.js";
import { DesktopSearchService } from "../src/search/service.js";
import { FixtureSearchPreferences } from "./central-semantics-fixture.js";
import type { SessionMapRecord } from "../src/acp/session-map.js";
import { enableSearchSources } from "./search-sources-fixture.js";
const signal = () => new AbortController().signal;
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const base = resolve(".pi/artifacts/session-background-discovery"); await mkdir(base,{recursive:true});
  const root = await mkdtemp(join(base,"case-")), agent = join(root,"agent");
  await enableSearchSources(root);
  const directory = nativeSessionDirectory(root,agent); await mkdir(directory,{recursive:true});
  const old = new Date(Date.now()-SESSION_IDLE_MS-1000);
  for (const id of ["a","b","recent"]) {
    const path = join(directory,`${id}.jsonl`);
    await writeFile(path,[{type:"session",id,cwd:root,timestamp:"2020-01-01T00:00:00.000Z"},
      {type:"message",id:"m",parentId:null,message:{role:"user",content:"Original prompt"}},
      {type:"session_info",id:"title",parentId:"m",name:`Title ${id}`}].map(r=>JSON.stringify(r)).join("\n")+"\n");
    if (id !== "recent") await utimes(path,old,old);
  }
  const policy = new SessionIdlePolicy(root), discovery = new BackgroundSessionDiscovery(async()=>[],agent);
  let discoveries=0, manual=0; const titles:string[]=[], errors:unknown[]=[];
  const chunks = new DesktopSessionChunks(root,{
    signal:signal(),policy,embedding:async()=>undefined,
    discover:async()=>{manual++;return discovery.list(root,signal());},
    discoverBackground:async s=>{discoveries++;return discovery.list(root,s);},
    titles:async r=>{titles.push(r.piSessionId);},failed:e=>{errors.push(e);},
  });
  t.after(async()=>{discovery.dispose();await chunks.dispose();await policy.dispose();await rm(root,{recursive:true,force:true});});
  const run = () => (chunks as unknown as {sync:{run(s:AbortSignal):Promise<void>}}).sync.run(signal());
  return {root,directory,policy,discovery,chunks,run,titles,errors,counts:()=>({discoveries,manual})};
}
test("ACP background never uses full discovery or rediscovers per eligible candidate",async t=>{
  const f=await fixture(t);
  await f.run(); assert.deepEqual(f.titles,["a","b"]);
  assert.deepEqual(f.counts(),{discoveries:1,manual:0});
  await f.run(); assert.deepEqual(f.titles,["a","b"]);
  assert.deepEqual(f.errors,[]);
  await f.chunks.index(signal(),true);
  assert.equal(f.counts().manual,1,"manual discovery remains available and bypasses idle");
});
test("Continue preflight skips discovery and an in-flight circuit stops the whole sweep",async t=>{
  const f=await fixture(t);
  await f.policy.observe("unrelated",false,false);
  const db=new DatabaseSync(join(f.root,".pi/search/sessions.sqlite"));
  try {
    const work=await claimWork(db,signal());await work.release(true);
    db.exec("UPDATE pix_search_work SET failures=2,expires=0");
    await f.run();assert.equal(f.counts().discoveries,0);assert.deepEqual(f.titles,[]);
    const retry=await claimWork(db,signal(),{retry:true});await retry.release(true);
    const options=(f.chunks as unknown as {options:{titles:()=>Promise<void>}}).options;
    let attempts=0;
    options.titles=async()=>{attempts++;throw new SearchWorkNeedsContinueError();};
    await f.run();assert.equal(attempts,1,"not one identical failure for every candidate");
    options.titles=async()=>{attempts++;};
    await f.run();assert.equal(attempts,3,"unprocessed revisions are not lost after Continue");
  } finally {db.close();}
});
test("background title hydration keeps Desktop map authority and authenticates native titles",async t=>{
  const f=await fixture(t),record=(await f.discovery.list(f.root,signal()))[0]!;
  const native=await hydrateBackgroundTitle(f.root,record,signal());
  assert.equal(native?.record.namedTitle,"Title a");
  const mapped={...record,nativeOnly:false,title:"Stale title",namedTitle:"Stale title",sessionId:"acp"};
  assert.equal((await hydrateBackgroundTitle(f.root,mapped,signal()))?.record.namedTitle,undefined);
  assert.equal((await hydrateBackgroundTitle(f.root,{...mapped,title:"Title a",namedTitle:"Title a"},signal()))?.record.namedTitle,"Title a");
});
test("partial title reconciliation preserves other sessions and handles identical titles",()=>{
  const db=new DatabaseSync(":memory:");
  try {
    const tx=createSessionIndexTransaction(db,signal());
    const a={sessionId:"a",title:"Same",hash:hashText("Same")},b={...a,sessionId:"b"};
    tx.reconcile([a,b]);
    tx.reconcileOne("c",{sessionId:"c",title:"Other",hash:hashText("Other")});
    assert.deepEqual(tx.missing(16,"b"),[b],"filter before GROUP BY, not after");
    tx.reconcileOne("c");assert.deepEqual(tx.missing(16,"b"),[b]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM pix_session_titles").get()!.n,2);
  } finally {db.close();}
});
test("ACP service hydrates one admitted title without full rediscovery or pruning other titles",async t=>{
  const f=await fixture(t), preferences=new FixtureSearchPreferences(join(f.root,"config.jsonc"));
  await preferences.configure(true,{embeddingProvider:"ollama",vectorSize:3});
  let fullScans=0;const calls:string[][]=[];
  const service=new DesktopSearchService({preferences,discover:async()=>{fullScans++;throw new Error("No background full scans");},
    discoverBackground:(cwd,s)=>f.discovery.list(cwd,s),
    embed:async inputs=>{calls.push([...inputs]);return inputs.map(()=>[1,0,0]);}});
  try {
    await service.config({cwd:f.root});
    const internals=service as unknown as {workspace:unknown;chunkIndexer(w:unknown):DesktopSessionChunks};
    const chunks=internals.chunkIndexer(internals.workspace);await chunks.dispose();
    const options=(chunks as unknown as {options:{titles(r:SessionMapRecord,s:AbortSignal):Promise<void>}}).options;
    const records=await f.discovery.list(f.root,signal());
    await options.titles(records[0]!,signal());await options.titles(records[1]!,signal());
    const prefix=(await preferences.embedding())!.documentPrefix;
    assert.equal(fullScans,0);assert.deepEqual(calls,[[prefix+"Title a"],[prefix+"Title b"]]);
    const db=new DatabaseSync(join(f.root,".pi/search/sessions.sqlite"),{readOnly:true});
    try {assert.equal(db.prepare("SELECT count(*) AS n FROM pix_session_titles").get()!.n,2);}
    finally {db.close();}
  } finally {await service.dispose();}
});
