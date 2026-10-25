import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { messageChunks, readSessionTranscript, sessionContext } from "../src/search/session-transcript.js";
import { parseSessionRecord } from "../src/search/session-record.js";
import { indexSessionChunks, searchSessionChunks } from "../src/search/session-chunks.js";
import { SessionChunkSync } from "../src/search/session-chunk-sync.js";
import { logSearchDiagnostic } from "../src/search/search-logging.js";
import { collectRagEvidence } from "../src/search/rag-evidence.js";
import { validateRagCitations } from "../src/search/rag-citations.js";

const signal = () => new AbortController().signal;
const message = (id:string,parentId:string|null,role:string,text:string) =>
  ({type:"message",id,parentId,message:{role,content:[{type:"text",text}],stopReason:"stop"}});
async function fixture(t:{after(fn:()=>Promise<unknown>):void}) {
  const base=resolve(".pi/artifacts/session-chunks-tests");await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,"case-"));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,".pi"),{recursive:true});
  await writeFile(join(root,".pi/workspace.jsonc"),JSON.stringify({ search: { sources: {sessions:true,tasks:false,commits:false,code:false,knowledge:false} } }));
  const candidate={id:"native-id",path:join(root,"session.jsonl")};
  const rows=[{type:"session",id:candidate.id,cwd:root},message("a",null,"user","Use rows"),
    message("b","a","assistant","I propose a circle"),message("c","b","user","yes"),
    message("d","c","assistant","I will arrange a circle"),message("e","d","user","No, rows again")];
  const save=async()=>writeFile(candidate.path,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
  await save();return {root,candidate,rows,save};
}
const config = (embed:(texts:string[],signal:AbortSignal)=>Promise<number[][]>) =>
  ({identity:"mock-v1",dimension:2,authorized:async()=>true,embed});

test("shared protocol twins stay byte-identical apart from module extension",async()=>{
  for(const name of ["session-transcript","session-record","session-text","session-chunks","session-chunk-sync","search-logging","session-index-progress","session-idle","source-policy","session-discovery","session-revisions","session-index-revision"]) {
    for(const [a,b] of [[".mjs",".js"],[".d.mts",".d.ts"]]) {
      const source=await readFile(new URL(`../../external/pi-tools-suite/src/project-search/${name}${a}`,import.meta.url),"utf8");
      assert.equal(await readFile(new URL(`../src/search/${name}${b}`,import.meta.url),"utf8"),source.replaceAll('.mjs"','.js"'));
    }
  }
  for(const name of ["session-byte-lines","session-chunk-store","session-chunk-query","session-read-cache"]) {
    const source=await readFile(new URL(`../../external/pi-tools-suite/src/project-search/${name}.mjs`,import.meta.url),"utf8");
    assert.equal(await readFile(new URL(`../src/search/${name}.js`,import.meta.url),"utf8"),source.replaceAll('.mjs"','.js"'));
  }
});
test("chunks preserve complete text, UTF-16 offsets and astral characters",()=>{
  const text="a".repeat(1599)+"😀"+"b".repeat(3201);
  const chunks=messageChunks(text);assert.equal(chunks.map(c=>c.text).join(""),text);
  for(const chunk of chunks){assert.equal(text.slice(chunk.start,chunk.end),chunk.text);assert.ok(chunk.text.length<=1600);assert.ok(!/[\uD800-\uDBFF]$/u.test(chunk.text));}
});
test("skipped transcripts reach shared Pix diagnostics with safe reason, not local files",async t=>{
  const symbol = Symbol.for("pix.diagnostics.sink");
  const globals = globalThis as Record<symbol, unknown>;
  const previous = globals[symbol];
  const events: Array<{event: string; details: Record<string, unknown>}> = [];
  globals[symbol] = (_level: string, event: string, details: Record<string, unknown>) => {
    events.push({event,details});
  };
  t.after(() => {
    if (previous === undefined) delete globals[symbol];
    else globals[symbol] = previous;
  });
  const f=await fixture(t);
  await appendFile(f.candidate.path,"PRIVATE MALFORMED TEXT");
  const result=await indexSessionChunks(f.root,[f.candidate,{id:"missing",path:join(f.root,"missing.jsonl")}],{signal:signal()});
  assert.equal(result.skipped,2);
  assert.equal(result.diagnostics?.[0]?.reason,"invalid_json");
  assert.equal(result.diagnostics?.[0]?.line,7);
  assert.equal(result.diagnostics?.[1]?.code,"ENOENT");
  await Promise.resolve();
  assert.ok(events.some(e=>e.event==="search:transcript-skipped"&&e.details.reason==="invalid_json"));
  assert.ok(events.some(e=>e.event==="search:transcript-skipped"&&e.details.reason==="stat_failed"&&e.details.code==="ENOENT"));
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE MALFORMED TEXT|session.jsonl|missing.jsonl/);
  assert.deepEqual(await readdir(join(f.root,".pi/artifacts")).catch(()=>[]),[]);
});
test("reader distinguishes validation failures without treating cancellation as a skip",async t=>{
  const f=await fixture(t);
  const reasons:string[]=[];
  const skipped=(d:{reason:string})=>{reasons.push(d.reason);};
  await readSessionTranscript(f.root,{...f.candidate,id:"wrong"},signal(),skipped);
  await readSessionTranscript(join(f.root,"other"),f.candidate,signal(),skipped);
  await writeFile(f.candidate.path,"");
  await readSessionTranscript(f.root,f.candidate,signal(),skipped);
  await f.save();await appendFile(f.candidate.path,JSON.stringify(message("z","missing","user","PRIVATE"))+"\n");
  await readSessionTranscript(f.root,f.candidate,signal(),skipped);
  await f.save();await appendFile(f.candidate.path,JSON.stringify(message("z","z","user","PRIVATE"))+"\n");
  await readSessionTranscript(f.root,f.candidate,signal(),skipped);
  await assert.rejects(readSessionTranscript(f.root,f.candidate,AbortSignal.abort(),skipped));
  assert.deepEqual(reasons,["session_id_mismatch","workspace_mismatch","empty_transcript","missing_parent","cyclic_parent_chain"]);
});
test("index logger never visits a redirected artifacts directory",async t=>{
  const f=await fixture(t),outside=join(f.root,"outside");
  await mkdir(outside);await mkdir(join(f.root,".pi"),{recursive:true});
  await symlink(outside,join(f.root,".pi/artifacts"));
  await logSearchDiagnostic(f.root,{event:"session_transcript_skipped",reason:"missing_parent",path:f.candidate.path});
  assert.deepEqual(await readdir(outside),[]);
});
test("active branch excludes abandoned messages, tools, thinking and attachments",async t=>{
  const f=await fixture(t);
  await appendFile(f.candidate.path,[message("tool","e","toolResult","PRIVATE TOOL"),
    {type:"message",id:"branch",parentId:"a",message:{role:"assistant",stopReason:"error",content:[
      {type:"thinking",thinking:"SECRET"},{type:"image",data:"IMAGE"},{type:"text",text:"Failed to change"}]}}].map(row=>JSON.stringify(row)).join("\n")+"\n");
  const s=(await readSessionTranscript(f.root,f.candidate,signal()))!;
  assert.deepEqual(s.messages.map(m=>m.id),["a","branch"]);assert.equal(s.messages[1]!.status,"error");
  assert.doesNotMatch(JSON.stringify(s),/SECRET|IMAGE|PRIVATE TOOL|circle/);
});
test("identity, cwd, corruption, dangling parents, symlinks and abort fail closed",async t=>{
  const f=await fixture(t);
  assert.equal(await readSessionTranscript(f.root,{...f.candidate,id:"wrong"},signal()),undefined);
  assert.equal(await readSessionTranscript(join(f.root,"other"),f.candidate,signal()),undefined);
  const link=join(f.root,"link.jsonl");await symlink(f.candidate.path,link);
  assert.equal(await readSessionTranscript(f.root,{...f.candidate,path:link},signal()),undefined);
  await appendFile(f.candidate.path,"{partial");assert.equal(await readSessionTranscript(f.root,f.candidate,signal()),undefined);
  await f.save();await appendFile(f.candidate.path,JSON.stringify(message("z","missing","user","reverse"))+"\n");
  assert.equal(await readSessionTranscript(f.root,f.candidate,signal()),undefined);
  await assert.rejects(readSessionTranscript(f.root,f.candidate,AbortSignal.abort()));
});
test("large images, thinking and tool payloads preserve ancestry and only embed public text",async t=>{
  const f=await fixture(t), payload="PRIVATE_ASSET".repeat(100000);
  const rows=[
    {type:"message",id:"image",parentId:"e",message:{role:"user",content:[
      {type:"text",text:"Short image caption"},{type:"image",data:payload}]}},
    {type:"message",id:"tool",parentId:"image",message:{role:"toolResult",content:payload}},
    {type:"message",id:"thinking",parentId:"tool",message:{role:"assistant",stopReason:"stop",content:[
      {type:"thinking",thinking:payload},{type:"text",text:"Image reviewed"}]}},
    {type:"custom",id:"meta",parentId:"thinking",data:payload},
    message("late","meta","user","Actually keep the original"),
  ];
  await appendFile(f.candidate.path,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
  const s=(await readSessionTranscript(f.root,f.candidate,signal()))!;
  assert.deepEqual(s.messages.slice(-3).map(m=>m.id),["image","thinking","late"]);
  assert.doesNotMatch(JSON.stringify(s),/PRIVATE_ASSET/);
  assert.match(sessionContext(s,"image")!,/Actually keep the original/);
  const sent:string[]=[];
  const result=await indexSessionChunks(f.root,[f.candidate],{signal:signal(),embedding:config(async texts=>{
    sent.push(...texts);return texts.map(()=>[1,0]);
  })});
  assert.equal(result.complete,true);assert.equal(result.skipped,0);
  assert.deepEqual(sent.slice(-3),["Short image caption","Image reviewed","Actually keep the original"]);
  assert.doesNotMatch(sent.join("\n"),/PRIVATE_ASSET/);
});
test("large records still validate JSON and bound public text without truncation",async t=>{
  const f=await fixture(t),reasons:string[]=[];
  const skipped=(d:{reason:string})=>{reasons.push(d.reason);};
  const large=JSON.stringify(message("z","e","user","x".repeat(1024*1024+1)));
  await appendFile(f.candidate.path,large+"\n");
  assert.equal(await readSessionTranscript(f.root,f.candidate,signal(),skipped),undefined);
  await f.save();await appendFile(f.candidate.path,large.slice(0,-1)+"\n");
  assert.equal(await readSessionTranscript(f.root,f.candidate,signal(),skipped),undefined);
  assert.deepEqual(reasons,["public_text_exceeds_limit","invalid_json"]);
});
test("large-record worker can be cancelled while parsing and later reads still work",async()=>{
  const controller=new AbortController();
  const line=JSON.stringify({type:"custom",id:"large",parentId:null,data:"x".repeat(2*1024*1024)});
  const pending=parseSessionRecord(line,controller.signal);
  controller.abort();await assert.rejects(pending,{name:"AbortError"});
  assert.equal((await parseSessionRecord(line,signal())).entry?.id,"large");
});
test("large records do not bypass identity, parent links or the file-size cap",async t=>{
  const f=await fixture(t),diagnostics:{reason:string}[]=[];
  const row={type:"message",id:"image",parentId:"missing",message:{role:"user",content:[
    {type:"text",text:"caption"},{type:"image",data:"x".repeat(2*1024*1024)}]}};
  await appendFile(f.candidate.path,JSON.stringify(row)+"\n");
  const skip=(d:{reason:string})=>{diagnostics.push(d);};
  assert.equal(await readSessionTranscript(f.root,f.candidate,signal(),skip),undefined);
  assert.equal(await readSessionTranscript(f.root,{...f.candidate,id:"wrong"},signal(),skip),undefined);
  await truncate(f.candidate.path,64*1024*1024+1);
  assert.equal(await readSessionTranscript(f.root,f.candidate,signal(),skip),undefined);
  assert.deepEqual(diagnostics.map(d=>d.reason),["missing_parent","session_id_mismatch","file_exceeds_64_mib"]);
});
test("missing parent diagnostics identify the child line and missing ID without repairing history",async t=>{
  const f=await fixture(t),diagnostics:unknown[]=[];
  await appendFile(f.candidate.path,JSON.stringify(message("child","lost","assistant","PRIVATE"))+"\n");
  assert.equal(await readSessionTranscript(f.root,f.candidate,signal(),d=>diagnostics.push(d)),undefined);
  assert.deepEqual(diagnostics,[{sessionId:f.candidate.id,path:f.candidate.path,reason:"missing_parent",line:7,entryId:"child",parentId:"lost"}]);
  const before=await readFile(f.candidate.path,"utf8");
  const indexed=await indexSessionChunks(f.root,[f.candidate],{signal:signal()});
  assert.deepEqual(indexed.diagnostics,diagnostics);
  // Detailed IDs stay in the bounded manual result, not in a second file log.
  const artifacts=await readdir(join(f.root,".pi/artifacts")).catch(()=>[]);
  assert.equal(artifacts.some(name=>name.startsWith("search-diagnostics-")),false);
  assert.equal(await readFile(f.candidate.path,"utf8"),before);
});
test("RAG retains short late reversals, rejects missing anchors and never truncates suffix",async t=>{
  const f=await fixture(t),s=(await readSessionTranscript(f.root,f.candidate,signal()))!;
  assert.match(sessionContext(s,"b")!,/No, rows again/);
  assert.equal(sessionContext(s,"unknown"),undefined);
  assert.match(sessionContext(s,"b",20)!,/^INCOMPLETE SESSION CONTEXT:/);
  const request={cwd:f.root,requestId:"test",query:"circle?",sources:[{id:"sessions:acp",kind:"sessions" as const,title:"s",sessionId:"acp",messageId:"b",snippet:"STALE"}]};
  assert.deepEqual(await collectRagEvidence(request,signal()),[]);
  const evidence=await collectRagEvidence(request,signal(),async()=>f.candidate);
  assert.match(evidence[0]!.text,/No, rows again/);assert.doesNotMatch(evidence[0]!.text,/STALE/);
  assert.equal(await evidence[0]!.current!(signal()),true);
  await appendFile(f.candidate.path,JSON.stringify(message("z","e","user","newer"))+"\n");
  assert.equal(await evidence[0]!.current!(signal()),false);
});
test("lexical middle/short-user retrieval is network-free; vector cache is shared and incremental",async t=>{
  const f=await fixture(t);let calls=0;
  const embedding=config(async texts=>{calls++;return texts.map(()=>[1,0]);});
  assert.deepEqual(await searchSessionChunks(f.root,[f.candidate],"yes",signal()),[]);
  await indexSessionChunks(f.root,[f.candidate],{signal:signal()});
  const lexical=await searchSessionChunks(f.root,[f.candidate],"yes",signal());
  assert.equal(lexical[0]!.messageId,"c");assert.equal(calls,0);
  const first=await indexSessionChunks(f.root,[f.candidate],{signal:signal(),embedding});
  assert.equal(first.complete,true);assert.equal(first.total,5);assert.equal(calls,1);
  await indexSessionChunks(f.root,[f.candidate],{signal:signal(),embedding});assert.equal(calls,1);
  assert.ok((await searchSessionChunks(f.root,[f.candidate],"unmatched",signal(),{identity:embedding.identity,dimension:2,query:[1,0]}))[0]!.semantic);
  assert.equal((await searchSessionChunks(f.root,[f.candidate],"unmatched",signal(),{identity:"other",dimension:2,query:[1,0]})).length,0);
  await appendFile(f.candidate.path,JSON.stringify(message("z","e","user","only new text"))+"\n");
  let inputs:string[]=[];
  await indexSessionChunks(f.root,[f.candidate],{signal:signal(),embedding:config(async texts=>{inputs=texts;return texts.map(()=>[1,0]);})});
  assert.deepEqual(inputs,["only new text"]);
});
test("mutation during provider latency cannot publish stale vectors",async t=>{
  const f=await fixture(t);
  await assert.rejects(indexSessionChunks(f.root,[f.candidate],{signal:signal(),embedding:config(async texts=>{
    await appendFile(f.candidate.path,JSON.stringify(message("z","e","user","new instruction"))+"\n");return texts.map(()=>[1,0]);
  })}),/Session changed/);
  const hits=await searchSessionChunks(f.root,[f.candidate],"unmatched",signal(),{identity:"mock-v1",dimension:2,query:[1,0]});
  assert.deepEqual(hits,[]);
});
test("concurrent hosts share one paid batch for identical message hashes",async t=>{
  const f=await fixture(t);let calls=0,enter!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const embedding=config(async texts=>{calls++;enter();await gate;return texts.map(()=>[1,0]);});
  const first=indexSessionChunks(f.root,[f.candidate],{signal:signal(),embedding});
  await ready;
  const second=indexSessionChunks(f.root,[f.candidate],{signal:signal(),embedding});
  release();
  const results=await Promise.all([first,second]);
  assert.equal(calls,1);assert.ok(results.every(result=>result.complete));
});
test("backfill reads later transcripts only when needed and reuses prior hashes",async t=>{
  const f=await fixture(t),later={id:"later",path:join(f.root,"later.jsonl")};
  const writeLater=(text:string)=>writeFile(later.path,[{type:"session",id:later.id,cwd:f.root},message("l",null,"user",text)].map(row=>JSON.stringify(row)).join("\n")+"\n");
  await writeLater("Old text");
  const sent:string[]=[];
  const embedding=config(async texts=>{
    sent.push(...texts);
    if(sent.length===5) await writeLater("Updated before enumeration");
    return texts.map(()=>[1,0]);
  });
  const result=await indexSessionChunks(f.root,[f.candidate,later],{signal:signal(),embedding,drain:true});
  assert.equal(result.complete,true);assert.equal(result.total,6);
  assert.ok(sent.includes("Updated before enumeration"));assert.ok(!sent.includes("Old text"));
});
test("bounded query indexing reports remainder and automatic drain finishes it",async t=>{
  const f=await fixture(t);
  const text=Array.from({length:300},(_,i)=>(`${i}:`+"x".repeat(1600)).slice(0,1600)).join("");
  f.rows.splice(1,f.rows.length-1,message("long",null,"user",text));await f.save();
  let calls=0;
  const embedding=config(async texts=>{calls++;assert.ok(texts.length<=16);return texts.map(()=>[1,0]);});
  const partial=await indexSessionChunks(f.root,[f.candidate],{signal:signal(),embedding});
  assert.deepEqual(partial,{indexed:256,total:300,complete:false,skipped:0});assert.equal(calls,16);
  const complete=await indexSessionChunks(f.root,[f.candidate],{signal:signal(),embedding,drain:true});
  assert.equal(complete.indexed,300);assert.equal(complete.complete,true);assert.equal(calls,19);
});
test("removed authorization and invalid float32 vectors cannot publish",async t=>{
  const f=await fixture(t);let authorized=true;
  await assert.rejects(indexSessionChunks(f.root,[f.candidate],{signal:signal(),embedding:{...config(async texts=>{
    authorized=false;return texts.map(()=>[1,0]);}),authorized:async()=>authorized}}),/configuration changed/);
  await assert.rejects(indexSessionChunks(f.root,[f.candidate],{signal:signal(),retry:true,embedding:config(async texts=>texts.map(()=>[1e100,0]))}),/Invalid/);
});
test("auto sync coalesces bursts, follows dirty work once and stops on teardown",async()=>{
  const owner=new AbortController();let calls=0,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const sync=new SessionChunkSync(async()=>{calls++;entered();await gate;},owner.signal);
  sync.changed();sync.changed();sync.start();await started;sync.changed();sync.changed();release();
  await sync.worker;sync.start();await sync.worker;assert.equal(calls,2);
  owner.abort();await sync.dispose();sync.changed();sync.start();assert.equal(calls,2);
});
test("citations accept canonical references only, not hallucinated or malformed labels",()=>{
  validateRagCitations("Approved [1], reported [2].",2);
  for(const answer of ["Nothing cited","Answer [0]","Answer [3]","Answer [Source 1,msg4]","Answer Source 1","Answer [4, Message #13]","Answer [1, 2]","Answer [01]"])
    assert.throws(()=>validateRagCitations(answer,2));
});
