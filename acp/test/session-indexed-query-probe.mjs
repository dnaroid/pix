// Separate process: no warm title/transcript caches can hide source reads.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const {root,candidates}=JSON.parse(await fs.readFile(process.argv[2],"utf8"));
let bytes=0,opens=0;
const originalOpen=fs.open.bind(fs), originalRead=fs.readFile.bind(fs);
fs.readFile=async(path,...args)=>{
  const value=await originalRead(path,...args);
  if(String(path).endsWith(".jsonl")){opens++;bytes+=Buffer.byteLength(value);}
  return value;
};
fs.open=async(path,...args)=>{
  const handle=await originalOpen(path,...args);
  if(String(path).endsWith(".jsonl")) {
    opens++;
    const stream=handle.createReadStream.bind(handle);
    handle.createReadStream=(...options)=>{const result=stream(...options);result.on("data",value=>{bytes+=value.length;});return result;};
  }
  return handle;
};
syncBuiltinESMExports();
const signal=new AbortController().signal,start=performance.now();
let lexical,firstQueryMs,semantic=[],excluded=0,abandoned=0;
if(process.argv[3]==="baseline") {
  const {readSessionTranscript}=await import("../src/search/session-transcript.js");
  lexical=[];
  for(const candidate of candidates){const s=await readSessionTranscript(root,candidate,signal);if(s?.chunks.some(c=>c.text.includes("needle")))lexical.push(candidate.id);}
  firstQueryMs=performance.now()-start;
} else {
  const {searchSessionChunks,listIndexedSessions,hasSessionChunkVectors}=await import("../src/search/session-chunks.js");
  await listIndexedSessions(root,signal);
  lexical=(await searchSessionChunks(root,candidates,"needle",signal)).map(h=>h.id);
  firstQueryMs=performance.now()-start;
  await hasSessionChunkVectors(root,candidates,signal,{identity:"test",dimension:2});
  semantic=(await searchSessionChunks(root,candidates,"unmatched",signal,{identity:"test",dimension:2,query:[1,0]})).map(h=>h.id);
  excluded=(await searchSessionChunks(root,candidates,"excludedword",signal)).length;
  abandoned=(await searchSessionChunks(root,candidates,"abandonedword",signal)).length;
}
console.log(JSON.stringify({bytes,opens,firstQueryMs,ms:performance.now()-start,lexical,semantic,excluded,abandoned}));
