import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/project-search/source-work.mjs";
import { ensureSessionRevision, readSessionIndexRevision } from "../src/project-search/session-index-revision.mjs";
import { beginSessionSweep, completeSessionSweep, SESSION_WATERMARK_OVERLAP_MS as overlap } from "../src/project-search/session-watermark.mjs";
import { IdleSessionSelection } from "../src/project-search/session-idle.mjs";
import { SESSION_MIN_AGE_MS as age } from "../src/project-search/session-revisions.mjs";
import { removeDirsWithRetry } from "./support/fs-retry.mjs";

const signal = () => new AbortController().signal;
const T = 2_000_000_000_000;
async function fixture(t) {
  const base = fileURLToPath(new URL("../../../.pi/artifacts/session-watermark-tests/",import.meta.url));
  await mkdir(base,{recursive:true});
  const root = await mkdtemp(join(base,"case-"));
  await mkdir(join(root,".pi/search"),{recursive:true});
  const db = await openDatabase(join(root,".pi/search/sessions.sqlite"));
  db.exec("CREATE TABLE pix_session_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  ensureSessionRevision(db);
  t.after(async () => { db.close(); await removeDirsWithRetry([root]); });
  return {root,db};
}
const candidate = (id,createdAt = T-age-10_000) => ({id,path:`/${id}.jsonl`,createdAt});
const policy = states => ({state: async c => states[c.id] ?? {eligible:true,changedAt:T-10_000,revision:`${c.id}:1`}});

test("persistent watermark stores start, survives reopening, and does not change the logical cache revision",async t => {
  const f = await fixture(t), pass = await beginSessionSweep(f.root,"model-a",signal(),() => T);
  const before = await readSessionIndexRevision(f.root,signal());
  assert.equal(pass.since,0);
  await completeSessionSweep(f.root,pass,signal(),() => T+600_000);
  const restart = await beginSessionSweep(f.root,"model-a",signal(),() => T+700_000);
  assert.equal(restart.since,T-overlap,"completion time must never cover work arriving during the pass");
  assert.deepEqual(await readSessionIndexRevision(f.root,signal()),before);
  assert.equal((await new IdleSessionSelection(policy({})).select([candidate("old")],signal(),restart.since)).length,0);
});
test("selection admits newly mature sessions, backdated edits/imports and boundary timestamps",async () => {
  const states = {
    edited:{eligible:true,changedAt:T+1,revision:"new"},
    imported:{eligible:true,changedAt:T+1,revision:"new"},
    boundary:{eligible:true,changedAt:T-overlap,revision:"same"},
  };
  const selection = new IdleSessionSelection(policy(states));
  const selected = await selection.select([candidate("old"),candidate("newly-mature",T-age+1),
    candidate("edited"),candidate("imported"),candidate("boundary")],signal(),T-overlap);
  assert.deepEqual(selected.map(c => c.id),["newly-mature","edited","imported","boundary"]);
});
test("failures and deferred candidates cannot be hidden by attempted-revision suppression",async () => {
  const states = {busy:{eligible:false,changedAt:T+1,revision:"busy:1"}};
  const selection = new IdleSessionSelection(policy(states));
  const candidates = [candidate("ok"),candidate("failed"),candidate("busy")];
  assert.equal((await selection.select(candidates,signal())).length,2);
  assert.equal(selection.complete,false);
  selection.succeeded(candidates[0]);
  assert.equal((await selection.select(candidates,signal())).length,0);
  assert.equal(selection.complete,false,"failed unchanged revisions are suppressed, not certified");
  assert.equal((await selection.select([candidates[0]],signal())).length,0);
  assert.equal(selection.complete,true,"a successful unchanged body need not be read again");
  assert.equal((await selection.select([{...candidates[0],changedAt:T+1}],signal())).length,1,
    "mapped title changes are not hidden by an unchanged transcript revision");
  selection.useCache("replacement");
  assert.equal((await selection.select([candidates[0]],signal())).length,1,"cache replacement discards in-memory success");
});
test("new identity, content mutation, cache replacement and backwards clocks invalidate the cutoff",async t => {
  const f = await fixture(t), pass = await beginSessionSweep(f.root,"a",signal(),() => T);
  await completeSessionSweep(f.root,pass,signal(),() => T+1);
  assert.equal((await beginSessionSweep(f.root,"b",signal(),() => T+2)).since,0);
  assert.equal((await beginSessionSweep(f.root,"a",signal(),() => T-1)).since,0);
  f.db.exec("INSERT INTO pix_session_meta VALUES('new','write')");
  assert.equal((await beginSessionSweep(f.root,"a",signal(),() => T+2)).since,0);
  f.db.exec("UPDATE pix_session_revision SET incarnation='replaced'");
  await completeSessionSweep(f.root,pass,signal(),() => T+3);
  assert.equal((await beginSessionSweep(f.root,"a",signal(),() => T+4)).since,0,"stale completion cannot certify replacement cache");
});
test("cancellation and clock rollback do not publish, older completions never move same-cache cutoff backwards",async t => {
  const f = await fixture(t), a = await beginSessionSweep(f.root,"a",signal(),() => T),
    b = await beginSessionSweep(f.root,"a",signal(),() => T+100);
  await assert.rejects(completeSessionSweep(f.root,a,AbortSignal.abort(),() => T+1));
  await completeSessionSweep(f.root,a,signal(),() => T-1);
  assert.equal((await beginSessionSweep(f.root,"a",signal(),() => T+1)).since,0);
  await completeSessionSweep(f.root,b,signal(),() => T+200);
  await completeSessionSweep(f.root,a,signal(),() => T+300);
  assert.equal((await beginSessionSweep(f.root,"a",signal(),() => T+400)).since,T+100-overlap);
});
test("a new project read does not initialize a search cache",async t => {
  const f = await fixture(t), missing = join(f.root,"new-project");
  await mkdir(missing);
  assert.equal((await beginSessionSweep(missing,"a",signal(),() => T)).since,0);
  await completeSessionSweep(missing,{startedAt:T,identity:"a",since:0,cacheRevision:"absent"},signal(),() => T+1);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(missing),[]);
});
