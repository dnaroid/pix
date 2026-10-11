import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionMapRecord } from "../src/acp/session-map.js";
import { DesktopSearchService, type SearchServiceOptions } from "../src/search/service.js";
import { SearchPreferences } from "../src/search/config.js";
import { parseSearchConfigRequest } from "../src/search/request.js";

async function fixture(t: TestContext, discover: SearchServiceOptions["discover"]) {
  const base = resolve("../.pi/artifacts/search-source-status");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(join(base, "run-"));
  const config = join(cwd, "config.jsonc");
  await writeFile(config, JSON.stringify({ search: { embedding: {
    embeddingProvider: "ollama", embeddingModel: "fake", vectorSize: 3,
  } } }));
  const service = new DesktopSearchService({ discover, preferences: new SearchPreferences(config),
    embed: async () => { assert.fail("Status must never request embeddings"); },
    watchTasks: () => { assert.fail("Status must never start indexing watchers"); } });
  t.after(async () => { await service.dispose(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, service, status: () => service.config({ cwd, includeSourceStatus: true }) };
}

test("source-status opt-in is strictly boolean and leaves the old request unchanged", () => {
  const cwd = resolve(".");
  assert.deepEqual(parseSearchConfigRequest({ cwd }), { cwd });
  assert.deepEqual(parseSearchConfigRequest({ cwd, includeSourceStatus: true }), { cwd, includeSourceStatus: true });
  for (const value of ["true", 1, null, {}]) assert.throws(() => parseSearchConfigRequest({ cwd, includeSourceStatus: value }));
  assert.throws(() => parseSearchConfigRequest({ cwd, includeSourceStatus: true, embeddingModel: "override" }));
});

test("empty-session status is read-only, throttled, and includes unnamed source sessions", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let records: SessionMapRecord[] = [], discoveries = 0;
  const f = await fixture(t, async () => { discoveries++; return records; });
  assert.equal((await f.service.config({ cwd: f.cwd })).sessionsEmpty, undefined);
  assert.equal(discoveries, 0);
  assert.equal((await f.status()).sessionsEmpty, true);
  records = [{ sessionId: "unnamed", piSessionId: "unnamed", piSessionPath: join(f.cwd, "session.jsonl"), cwd: f.cwd,
    title: "Display fallback, not a saved name", updatedAt: "2026-10-11T00:00:00Z" }];
  assert.equal((await f.status()).sessionsEmpty, true);
  assert.equal(discoveries, 1);
  t.mock.timers.tick(30_000);
  assert.equal((await f.status()).sessionsEmpty, false);
  assert.equal(discoveries, 2);
  await assert.rejects(access(join(f.cwd, ".pi/search")));
});

test("failed discovery clears empty status to unknown instead of hiding actions", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let failed = false;
  const f = await fixture(t, async () => { if (failed) throw new Error("discovery failure"); return []; });
  assert.equal((await f.status()).sessionsEmpty, true);
  failed = true;
  t.mock.timers.tick(30_000);
  assert.equal((await f.status()).sessionsEmpty, undefined);
  await assert.rejects(access(join(f.cwd, ".pi/search")));
});

test("cancelled discovery cannot publish a stale empty status", async t => {
  let started!: () => void, finish!: (records: SessionMapRecord[]) => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const discovery = new Promise<SessionMapRecord[]>(resolve => { finish = resolve; });
  const f = await fixture(t, async () => { started(); return discovery; });
  const controller = new AbortController();
  const pending = f.service.config({ cwd: f.cwd, includeSourceStatus: true }, controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(pending);
  finish([]);
  assert.equal((await f.service.config({ cwd: f.cwd })).sessionsEmpty, undefined);
  await assert.rejects(access(join(f.cwd, ".pi/search")));
});
