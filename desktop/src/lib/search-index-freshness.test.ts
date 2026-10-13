import { describe, expect, it, vi } from "vitest";
import { createSearchIndexFreshness, snapshotFreshness, type SnapshotObservation, type SnapshotObservations } from "./search-index-freshness";

const source = "a".repeat(64), changed = "b".repeat(64), index = "c".repeat(64);
const observation = (extra = {}): SnapshotObservation => ({ source, index, checkedAt: 100, ...extra });
const receipt = { source, index, checkedAt: 100, complete: true };
const signal = () => new AbortController().signal;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let now = 100;
  let next: SnapshotObservations = { tasks: observation() };
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const probe = vi.fn(async () => ({ observations: next }));
  const options = { workspace: "/project", probe, storage, now: () => now };
  return { options, probe, storage, create: () => createSearchIndexFreshness(options),
    next: (value: SnapshotObservations) => { next = value; }, time: (value: number) => { now = value; } };
}
describe("snapshot freshness and coverage are independent", () => {
  it("compares repository content to its index without requiring a manual receipt", () => {
    const current = observation({ indexPresent: true, matchesIndex: true });
    expect(snapshotFreshness(undefined, current, 100)).toMatchObject({ state: "current", coverage: "unknown" });
    expect(snapshotFreshness(receipt, { ...current, index: changed }, 100)).toMatchObject({ state: "current", coverage: "complete" });
    expect(snapshotFreshness(undefined, { ...current, matchesIndex: false }, 100)).toMatchObject({ state: "changed", coverage: "unknown" });
    expect(snapshotFreshness(undefined, { ...current, indexPresent: false }, 100).state).toBe("untracked");
    expect(snapshotFreshness(receipt, { ...current, error: "failed" }, 100).state).toBe("unchecked");
    expect(snapshotFreshness(receipt, current, 120101).state).toBe("unchecked");
  });
  it("never equates counts/no receipt/failure/stale checks with complete coverage", () => {
    expect(snapshotFreshness(undefined, observation(), 100)).toMatchObject({ state: "untracked", coverage: "unknown" });
    expect(snapshotFreshness(receipt, { checkedAt: 100, error: "failed" }, 100).state).toBe("unchecked");
    const racing = { checkedAt: 100, error: "Index changed during check" };
    expect(snapshotFreshness(receipt, racing, 100)).toMatchObject({ state: "index-changing", coverage: "complete" });
    expect(snapshotFreshness(undefined, racing, 100)).toMatchObject({ state: "index-changing", coverage: "unknown" });
    expect(snapshotFreshness(receipt, racing, 120101).state).toBe("unchecked");
    expect(snapshotFreshness(receipt, racing, 99).state).toBe("unchecked");
    expect(snapshotFreshness(receipt, observation(), 120101).state).toBe("unchecked");
    expect(snapshotFreshness(receipt, observation(), 99).state).toBe("unchecked");
    expect(snapshotFreshness({ ...receipt, complete: false }, observation(), 100)).toMatchObject({ state: "current", coverage: "partial" });
    expect(snapshotFreshness(receipt, observation({ source: changed }), 100)).toMatchObject({ state: "changed", coverage: "complete" });
    expect(snapshotFreshness(receipt, observation({ index: changed }), 100)).toMatchObject({ state: "index-changed", coverage: "complete" });
    expect(snapshotFreshness(receipt, observation({ indexPresent: false }), 100)).toMatchObject({ state: "index-changed", coverage: "complete" });
  });
  it.each(["code", "knowledge", "settings", "sessions", "tasks", "commits"] as const)("records stable full %s passes and rechecks persisted receipts", async source => {
    const f = fixture(); f.next({ [source]: observation() });
    const service = f.create();
    await service.run(source, signal(), async () => ({ source, complete: true, indexed: 2, total: 2 }));
    expect((await service.read(signal()))[source]).toMatchObject({ state: "current", coverage: "complete" });
    const restarted = f.create();
    f.next({ [source]: observation({ source: changed }) });
    expect((await restarted.read(signal()))[source]?.state).toBe("changed");
  });
  it("throttles automatic metadata checks but forces explicit Refresh", async () => {
    const f = fixture(), service = f.create();
    await service.read(signal()); await service.read(signal());
    expect(f.probe).toHaveBeenCalledTimes(1);
    await service.read(signal(), true); expect(f.probe).toHaveBeenCalledTimes(2);
    f.time(60100); await service.read(signal()); expect(f.probe).toHaveBeenCalledTimes(3);
  });
  it("keeps cache churn on the bounded metadata cadence without inventing coverage", async () => {
    const f = fixture(), service = f.create();
    f.next({ tasks: { checkedAt: 100, error: "Index changed during check" } });
    expect((await service.read(signal())).tasks).toMatchObject({ state: "index-changing", coverage: "unknown" });
    f.time(60099); await service.read(signal()); expect(f.probe).toHaveBeenCalledTimes(1);
    f.next({ tasks: observation({ checkedAt: 60100 }) });
    f.time(60100);
    expect((await service.read(signal())).tasks).toMatchObject({ state: "untracked", coverage: "unknown" });
    expect(f.probe).toHaveBeenCalledTimes(2);
  });
  it("changes during the run prevent a completed receipt and request Continue", async () => {
    const f = fixture(), service = f.create();
    const result = await service.run("tasks", signal(), async () => {
      f.next({ tasks: observation({ source: changed }) }); return { source: "tasks", complete: true };
    });
    expect(result.complete).toBe(false);
    expect((await service.read(signal())).tasks?.coverage).not.toBe("complete");
    expect((await service.read(signal())).tasks?.state).toBe("changed");
  });
  it("never certifies a removed index even if a just-finished transport said complete", async () => {
    const f = fixture(), service = f.create();
    await service.run("tasks", signal(), async () => {
      f.next({ tasks: observation({ indexPresent: false }) }); return { source: "tasks", complete: true };
    });
    expect((await service.read(signal())).tasks?.coverage).toBe("unknown");
  });
  it("a failed cheap probe never blocks indexing or manufactures freshness", async () => {
    const f = fixture(), service = f.create(), run = vi.fn(async () => ({ source: "tasks" as const, complete: true }));
    f.probe.mockRejectedValue(new Error("unavailable"));
    await service.run("tasks", signal(), run);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await service.read(signal())).tasks).toMatchObject({ state: "unchecked", coverage: "unknown" });
  });
  it("cancellation after transport completion cannot save a receipt", async () => {
    const f = fixture(), service = f.create(), controller = new AbortController();
    await expect(service.run("tasks", controller.signal, async () => {
      controller.abort(); return { source: "tasks", complete: true };
    })).rejects.toThrow();
    expect((await f.create().read(signal())).tasks?.coverage).toBe("unknown");
  });
  it("configuration invalidation fences late indexing completion", async () => {
    const f = fixture(), service = f.create();
    await service.run("tasks", signal(), async () => {
      service.invalidate(); return { source: "tasks", complete: true };
    });
    expect((await service.read(signal())).tasks?.coverage).toBe("unknown");
  });
  it("stale read completion cannot replace post-run observations", async () => {
    const f = fixture(), service = f.create();
    const pending = deferred<{ observations: SnapshotObservations }>();
    f.probe.mockImplementationOnce(() => pending.promise);
    const read = service.read(signal());
    await service.run("tasks", signal(), async () => ({ source: "tasks", complete: true }));
    pending.resolve({ observations: { tasks: observation({ source: changed }) } });
    expect((await read).tasks?.state).toBe("current");
  });
  it("malformed storage is not trusted", async () => {
    const f = fixture(); f.storage.setItem("pix.search-snapshot.v1:/project", '{"tasks":{"complete":true}}');
    expect((await f.create().read(signal())).tasks?.coverage).toBe("unknown");
  });
  it("reads CLI receipts from shared storage, drops removed receipts, and exposes external runs", async () => {
    const probe = vi.fn(async () => ({ observations: { tasks: observation() }, runs: { tasks: { receipt, state: "complete" } } }));
    const service = createSearchIndexFreshness({ workspace: "/project", shared: true, probe, now: () => 100 });
    expect((await service.read(signal())).tasks).toMatchObject({ state: "current", coverage: "complete", runState: "complete" });
    probe.mockResolvedValueOnce({ observations: { tasks: observation() }, runs: { tasks: { receipt: undefined as never, state: "running" } } });
    expect((await service.read(signal(), true)).tasks).toMatchObject({ state: "untracked", coverage: "unknown", runState: "running" });
    probe.mockRejectedValueOnce(new Error("unavailable"));
    expect((await service.read(signal(), true)).tasks).toMatchObject({ state: "unchecked", coverage: "unknown", runState: undefined });
  });
  it("invalidation fences a late shared receipt read", async () => {
    const pending = deferred<{ observations: SnapshotObservations; runs: { tasks: { receipt: typeof receipt; state: string } } }>();
    const probe = vi.fn(() => pending.promise);
    const service = createSearchIndexFreshness({ workspace: "/project", shared: true, probe, now: () => 100 });
    const reading = service.read(signal());
    service.invalidate();
    pending.resolve({ observations: { tasks: observation() }, runs: { tasks: { receipt, state: "complete" } } });
    expect((await reading).tasks?.coverage).toBe("unknown");
  });
  it("retains historical receipt on transient failure, retries sooner, and does not retain live activity", async () => {
    let now = 100;
    const probe = vi.fn().mockResolvedValue({ observations: { tasks: observation() }, runs: { tasks: { receipt, state: "complete" } } });
    const service = createSearchIndexFreshness({ workspace: "/project", shared: true, probe, now: () => now });
    await service.read(signal());
    probe.mockRejectedValueOnce(new Error("temporary"));
    expect((await service.read(signal(), true)).tasks).toMatchObject({ state: "unchecked", coverage: "complete", runState: undefined });
    now = 5100;
    expect((await service.read(signal())).tasks).toMatchObject({ state: "current", coverage: "complete" });
    expect(probe).toHaveBeenCalledTimes(3);
  });
});
