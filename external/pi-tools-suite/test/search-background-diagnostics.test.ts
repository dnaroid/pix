import { expect, spyOn, test } from "bun:test";
import { classifyIndexFailure, createBackgroundIndexFailureLogger, isExpectedIndexCancellation } from "../src/project-search/search-logging.mjs";
import { SessionChunkSync } from "../src/project-search/session-chunk-sync.mjs";
import { sessionIndexProgress } from "../src/project-search/session-index-progress.mjs";

test("indexing failures are classified, coalesced and never include provider text", async () => {
  const records: any[] = [];
  let now = 0;
  const log = createBackgroundIndexFailureLogger({
    now: () => now,
    write: async (_root: string, record: unknown) => { records.push(record); },
  });
  const error = Object.assign(new Error("PRIVATE_PROVIDER_TOKEN"), { code: "SQLITE_LOCKED" });
  log("/fixture", error, "sweep");
  await Promise.resolve();
  for (let i = 0; i < 30; i++) log("/fixture", error, "sweep");
  expect(records).toHaveLength(1);
  now += 300_000;
  log("/fixture", error, "sweep");
  await Promise.resolve();
  expect(records[1]).toMatchObject({ reason: "worker_failed", phase: "sweep", code: "SQLITE_LOCKED",
    errorType: "Error", suppressed: 30 });
  expect(JSON.stringify(records)).not.toContain("PRIVATE_PROVIDER_TOKEN");
  expect(classifyIndexFailure(Object.assign(new Error("secret"), { code: "PRIVATE_CREDENTIAL" })))
    .toEqual({ errorType: "Error" });
  const abort = new DOMException("PRIVATE_CANCEL", "AbortError");
  log("/fixture", abort, "indexing");
  log("/fixture", new Error("Search source selection changed"), "selection");
  await Promise.resolve();
  expect(records).toHaveLength(2);
  expect(isExpectedIndexCancellation(new Error("Search source selection changed"))).toBe(true);
  log("/fixture", new Error("Search source policy unavailable"), "policy");
  await Promise.resolve();
  expect(records).toHaveLength(3);
});

test("index progress failures include safe cause metadata, not provider text", async () => {
  const records: any[] = [];
  const progress = sessionIndexProgress("/unused", 1, async (_root: string, record: unknown) => {
    records.push(record);
  });
  progress.state.phase = "provider";
  await progress.finish("failed", Object.assign(new Error("PRIVATE_TOKEN_IN_PROVIDER_BODY"), {
    code: "SQLITE_BUSY",
  }));
  expect(records.at(-1)).toMatchObject({
    event: "session_index_progress", status: "failed", phase: "provider",
    errorType: "Error", code: "SQLITE_BUSY",
  });
  expect(JSON.stringify(records)).not.toContain("PRIVATE_TOKEN_IN_PROVIDER_BODY");
});

test("suite idle sync preserves automatic recovery but backs off repeated failures", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const timers: Array<{ ms: number; fire(): void }> = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    const handle = realSetTimeout(callback, 3_600_000);
    timers.push({ ms, fire: () => { clearTimeout(handle); callback(); } });
    return handle;
  }) as typeof setTimeout);
  const controller = new AbortController();
  let attempts = 0;
  const sync = new SessionChunkSync(async () => { attempts++; throw new Error("index failed"); }, controller.signal);
  try {
    sync.changed();
    expect(timers.at(-1)?.ms).toBe(250);
    timers.at(-1)!.fire();
    await sync.worker;
    expect(timers.at(-1)?.ms).toBe(120_000);
    timers.at(-1)!.fire();
    await sync.worker;
    expect(timers.at(-1)?.ms).toBe(240_000);
    sync.changed();
    timers.at(-1)!.fire();
    await sync.worker;
    expect(timers.at(-1)?.ms).toBe(120_000);
    expect(attempts).toBe(3);
  } finally {
    controller.abort();
    await sync.dispose();
    timer.mockRestore();
  }
});

test("suite incomplete pass gets a recovery cooldown without manufacturing an error", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const timers: Array<{ ms: number; fire(): void }> = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    const handle = realSetTimeout(callback, 3_600_000);
    timers.push({ ms, fire: () => { clearTimeout(handle); callback(); } });
    return handle;
  }) as typeof setTimeout);
  const controller = new AbortController();
  let attempts = 0;
  let unexpectedFailures = 0;
  const sync = new SessionChunkSync(async () => {
    if (++attempts === 1) sync.noteIncomplete();
  }, controller.signal, () => { unexpectedFailures++; });
  try {
    sync.changed();
    timers.at(-1)!.fire();
    await sync.worker;
    expect(timers.at(-1)?.ms).toBe(120_000);
    timers.at(-1)!.fire();
    await sync.worker;
    expect(timers.at(-1)?.ms).toBe(30_000);
    expect(unexpectedFailures).toBe(0);
  } finally {
    controller.abort();
    await sync.dispose();
    timer.mockRestore();
  }
});
