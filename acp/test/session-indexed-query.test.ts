import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexSessionChunks, listIndexedSessions, searchSessionChunks } from "../src/search/session-chunks.js";
async function setSearchSources(root:string, enabled:{sessions:boolean}) {
  await mkdir(join(root,".pi"),{recursive:true});
  await writeFile(join(root,".pi/search-sources.json"),JSON.stringify({version:1,
    enabled:{settings:false,code:false,knowledge:false,tasks:false,commits:false,...enabled}}));
}

const run = promisify(execFile);
const signal = () => new AbortController().signal;
const message = (id:string,parentId:string|null,text:string) =>
  ({type:"message",id,parentId,message:{role:"user",content:[{type:"text",text}]}});
async function fixture(t:{after(fn:()=>Promise<unknown>):void}) {
  const base=fileURLToPath(new URL("../../.pi/artifacts/session-index-only-tests/",import.meta.url));
  await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,"case-"));t.after(()=>rm(root,{recursive:true,force:true}));
  await setSearchSources(root,{sessions:true});
  const candidate={id:"session",path:join(root,"session.jsonl")};
  const rows: any[]=[{type:"session",id:candidate.id,cwd:root},message("a",null,"начало 😀"),
    message("old","a","abandonedword"),message("b","a","needle актуальная ветка"),
    {type:"session_info",id:"title",parentId:"b",name:"Indexed title"}];
  const save=()=>writeFile(candidate.path,rows.map(r=>JSON.stringify(r)).join("\r\n")+"\r\n");
  await save();return {root,candidate,rows,save};
}
const embedding={identity:"test",dimension:2,authorized:async()=>true,
  embed:async(texts:string[])=>texts.map(t=>t.includes("needle")?[1,0]:[0,1])};

test("indexed ranges are UTF-8 byte exact, branch-safe and invalidated on append/fork/replacement",async t=>{
  const f=await fixture(t);
  await indexSessionChunks(f.root,[f.candidate],{signal:signal(),embedding});
  const find=()=>searchSessionChunks(f.root,[f.candidate],"needle",signal());
  const [hit]=await find();assert.ok(hit);assert.equal(hit.messageId,"b");
  assert.equal(hit.title,"Indexed title");assert.equal(hit.active,true);
  assert.equal(hit.snippet,"needle актуальная ветка");assert.ok(hit.revision && hit.fileStamp);
  const handle=await open(hit.path,"r");
  try {
    const bytes=Buffer.alloc(hit.byteLength);
    const read=await handle.read(bytes,0,bytes.length,hit.byteOffset);
    assert.equal(read.bytesRead,bytes.length);assert.equal(JSON.parse(bytes.toString()).id,"b");
  } finally {await handle.close();}
  assert.deepEqual(await searchSessionChunks(f.root,[f.candidate],"abandonedword",signal()),[]);
  await appendFile(f.candidate.path,JSON.stringify(message("c","title","addedword"))+"\n");
  assert.deepEqual(await find(),[]);assert.deepEqual(await listIndexedSessions(f.root,signal()),[]);
  await indexSessionChunks(f.root,[f.candidate],{signal:signal()});
  assert.equal((await searchSessionChunks(f.root,[f.candidate],"addedword",signal())).length,1);
  await appendFile(f.candidate.path,JSON.stringify(message("fork","a","newbranch"))+"\n");
  assert.deepEqual(await find(),[]);
  await indexSessionChunks(f.root,[f.candidate],{signal:signal()});
  assert.deepEqual(await find(),[]);
  assert.equal((await searchSessionChunks(f.root,[f.candidate],"newbranch",signal())).length,1);
  const replacement=f.candidate.path+".new";
  await writeFile(replacement,f.rows.map(r=>JSON.stringify(r)).join("\n")+"\n");
  await rename(replacement,f.candidate.path);
  assert.deepEqual(await listIndexedSessions(f.root,signal()),[]);
  await indexSessionChunks(f.root,[f.candidate],{signal:signal()});assert.equal((await find()).length,1);
  await assert.rejects(searchSessionChunks(f.root,[f.candidate],"needle",AbortSignal.abort()));
  await setSearchSources(f.root,{sessions:false});
  await assert.rejects(find(),/disabled/);
});

test("cold indexed queries read zero JSONL bytes and preserve lexical/semantic targets",async t=>{
  const f=await fixture(t),candidates=[];
  for(let i=0;i<48;i++) {
    const candidate={id:`s${i}`,path:join(f.root,`s${i}.jsonl`)};candidates.push(candidate);
    // Large excluded attachment dominates physical bytes but must never become evidence.
    const rows=[{type:"session",id:candidate.id,cwd:f.root},message("a",null,`context ${i}`),
      message("old","a","abandonedword"),message("b","a",i===7?"needle актуальная ветка":"other topic"),
      {type:"message",id:"attachment",parentId:"b",message:{role:"user",content:[{type:"image",data:"excludedword".repeat(24000)}]}}];
    await writeFile(candidate.path,rows.map(r=>JSON.stringify(r)).join("\n")+"\n");
  }
  await indexSessionChunks(f.root,candidates,{signal:signal(),embedding,drain:true});
  const input=join(f.root,"input.json");await writeFile(input,JSON.stringify({root:f.root,candidates}));
  const script=fileURLToPath(new URL("./session-indexed-query-probe.mjs",import.meta.url));
  const baseline=JSON.parse((await run(process.execPath,[script,input,"baseline"])).stdout);
  const cold=JSON.parse((await run(process.execPath,[script,input,"indexed"])).stdout);
  assert.ok(baseline.bytes>3_000_000);assert.equal(cold.bytes,0);assert.equal(cold.opens,0);
  assert.equal(cold.lexical[0],"s7");assert.equal(cold.semantic[0],"s7");
  assert.equal(cold.excluded,0);assert.equal(cold.abandoned,0);
  assert.deepEqual(cold.lexical,baseline.lexical);
  const report=fileURLToPath(new URL("../../.pi/artifacts/session-index-only-tests/",import.meta.url));
  const output=await mkdtemp(join(report,"measurement-"));
  await writeFile(join(output,"cold.json"),JSON.stringify({baseline,cold},null,2));
  t.diagnostic(`Cold-query measurement: ${join(output,"cold.json")}`);
});
