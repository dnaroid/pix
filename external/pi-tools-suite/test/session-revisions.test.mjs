import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { SessionRevisionCatalog, SESSION_MIN_AGE_MS, SESSION_RECONCILE_MS } from "../src/project-search/session-revisions.mjs";
import { SessionCandidateCatalog, nativeSessionDirectory } from "../src/project-search/session-discovery.mjs";
const signal = () => new AbortController().signal;
async function fixture(t) {
  const base = resolve(".pi/artifacts/session-revision-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-")), agent = join(root, "agent"), directory = nativeSessionDirectory(root, agent);
  await mkdir(directory, { recursive: true });
  let now = Date.now(), callback, closed = 0;
  const catalog = new SessionRevisionCatalog({ now: () => now, watchDirectory: (_dir, _options, cb) => {
    callback = cb; const watcher = new EventEmitter(); watcher.close = () => { closed++; }; return watcher;
  } });
  t.after(async () => { catalog.dispose(); await rm(root, { recursive: true, force: true }); });
  const save = async (id, age) => {
    const filename = join(directory, `${id}.jsonl`);
    await writeFile(filename, JSON.stringify({ type: "session", id, cwd: root, timestamp: new Date(now - age).toISOString() }) + "\nINVALID BODY");
    return filename;
  };
  return { root, agent, directory, catalog, save, list: () => catalog.list(directory, [], signal()),
    advance: ms => { now += ms; }, event: name => callback("change", name), closed: () => closed };
}
test("24h creation gate ignores young appends; maturity admission needs no event", async t => {
  const f = await fixture(t), young = await f.save("young", SESSION_MIN_AGE_MS - 1000);
  assert.deepEqual(await f.list(), []);
  await appendFile(young, "append"); f.event("young.jsonl");
  assert.equal(f.catalog.dirty.size, 0);
  assert.equal(f.catalog.files.get(young).revision, undefined);
  f.advance(1000);
  const [mature] = await f.list(); assert.equal(mature.path, young);
  await appendFile(young, "another message"); f.event("young.jsonl");
  const [updated] = await f.list();
  assert.notEqual(updated.revision, mature.revision);
  assert.equal(updated.createdAt, mature.createdAt, "editing never restarts the age wait");
});
test("warm polls coalesce dirty paths; missed-event reconciliation, rename and teardown", async t => {
  const f = await fixture(t), a = await f.save("a", 2 * SESSION_MIN_AGE_MS);
  const [first] = await f.list();
  await appendFile(a, "silent write");
  assert.equal((await f.list())[0].revision, first.revision, "warm poll reuses event catalog");
  f.advance(SESSION_RECONCILE_MS);
  assert.notEqual((await f.list())[0].revision, first.revision, "missed events are reconciled");
  await rename(a, join(f.directory, "b.jsonl")); f.event("a.jsonl"); f.event("b.jsonl"); f.event("b.jsonl");
  assert.equal(f.catalog.dirty.size, 2);
  assert.deepEqual((await f.list()).map(r => r.path), [join(f.directory, "b.jsonl")]);
  f.catalog.dispose(); assert.equal(f.closed(), 1);
  await assert.rejects(f.list(), /disposed/);
});
test("young invalid bodies never reach header identity or title hydration; digest is stable", async t => {
  const f = await fixture(t); await f.save("young", 0);
  const catalog = new SessionCandidateCatalog({ watching: false }); t.after(() => catalog.dispose());
  let headers = 0;
  catalog.header = async () => { headers++; throw new Error("Young session header reached identity discovery"); };
  assert.deepEqual(await catalog.list(f.root, f.agent, signal()), []);
  assert.equal(headers, 0);
  const before = await catalog.snapshot(f.root, f.agent, signal());
  await appendFile(join(f.directory, "young.jsonl"), "more tool payload");
  assert.equal(await catalog.snapshot(f.root, f.agent, signal()), before);
});
