import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopSessionChunks } from "../src/search/session-chunk-service.js";
import { SessionIdlePolicy } from "../src/search/session-idle.js";
import { beginSessionSweep } from "../src/search/session-watermark.js";
import type { BackgroundSessionRecord } from "../src/search/background-session-discovery.js";

test("automatic sweeps resume after restart without old body reads and admit a newly 24h session",async t => {
  const base = fileURLToPath(new URL("../../.pi/artifacts/session-sweep-tests/",import.meta.url));
  await mkdir(base,{recursive:true});
  const root = await mkdtemp(join(base,"case-")), originalNow = Date.now;
  let now = 2_000_000_000_000;
  Date.now = () => now;
  const signal = new AbortController().signal;
  const policy = new SessionIdlePolicy(root,() => now);
  const owners: DesktopSessionChunks[] = [], titles: string[] = [], failures: unknown[] = [];
  let failTitle = "";
  t.after(async () => {
    for (const owner of owners) await owner.dispose();
    await policy.dispose(); Date.now = originalNow; await rm(root,{recursive:true,force:true});
  });
  const records: BackgroundSessionRecord[] = [];
  async function save(id: string,createdAt: number) {
    const path = join(root,`${id}.jsonl`);
    await writeFile(path,JSON.stringify({type:"session",id,cwd:root,timestamp:new Date(createdAt).toISOString()})+"\n"+
      JSON.stringify({type:"message",id:"m",parentId:null,message:{role:"user",content:[{type:"text",text:"needle"}]}})+"\n");
    await utimes(path,new Date(now-3_600_001),new Date(now-3_600_001));
    records.push({sessionId:id,piSessionId:id,piSessionPath:path,cwd:root,updatedAt:"",createdAt});
  }
  const make = () => {
    const owner = new DesktopSessionChunks(root,{signal,policy,discover:async () => records,
      discoverBackground:async () => records,embedding:async () => undefined,
      titles:async record => {
        titles.push(record.piSessionId);
        if (record.piSessionId === failTitle) throw new Error("title failed");
      },failed:error => failures.push(error)});
    owners.push(owner); return owner;
  };
  const run = async (owner: DesktopSessionChunks) => {
    // Drive the actual sweep, not the debounce timer; timer lifecycle is covered separately.
    await (owner as unknown as {sync:{run(signal:AbortSignal):Promise<void>}}).sync.run(signal);
  };
  await save("old",now-7*86_400_000);
  const first = make(); await run(first); await first.dispose();
  assert.deepEqual(titles,["old"]);
  const initial = await beginSessionSweep(root,"lexical-only",signal);
  assert.equal(initial.since,now-2000);
  now += 60_000;
  const restarted = make(); await run(restarted);
  assert.deepEqual(titles,["old"],"restart must use the database cutoff, not an in-memory attempted map");
  await save("newly-mature",now-86_400_000);
  await run(restarted);
  assert.deepEqual(titles,["old","newly-mature"],"old mtime does not hide crossing the 24h boundary");
  assert.deepEqual(failures,[]);
  // Candidate discovery is still complete; cache/query callers never see a filtered list.
  assert.equal(records.length,2);
  const successful = await beginSessionSweep(root,"lexical-only",signal);
  now += 60_000;
  await save("failed",now-86_400_000); failTitle = "failed";
  await run(restarted);
  assert.equal((await beginSessionSweep(root,"lexical-only",signal)).since,successful.since);
  const reads = titles.length;
  await run(restarted);
  assert.equal(titles.length,reads,"an unchanged failure is not retried in a tight loop");
  assert.equal((await beginSessionSweep(root,"lexical-only",signal)).since,successful.since,
    "suppressed failure must not be mistaken for a complete pass");
  assert.equal(failures.length,1);
  failTitle = ""; await restarted.dispose(); await run(make());
  assert.equal(titles[titles.length-1],"failed");
  assert.equal((await beginSessionSweep(root,"lexical-only",signal)).since,now-2000);
});
