import { expect, it, vi } from "vitest";
import { querySnapshot } from "./snapshot-search-queue";
import type { IdxCommandResult } from "./idx";

const query = { kind: "knowledge", query: "title", limit: 15 } as const;
const ok: IdxCommandResult = { stdout: "", stderr: "", exitCode: 0, truncated: false };
const busy = { ...ok, exitCode: 1, stderr: "Search failed: Lock file is already being held" };
const signal = () => new AbortController().signal;
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }

it("serializes same-workspace requests but not different projects", async () => {
  const first = gate<IdxCommandResult>();
  const invoke = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(ok);
  const a = querySnapshot("/serial", query, signal(), invoke);
  const b = querySnapshot("/serial", query, signal(), invoke);
  const c = querySnapshot("/other", query, signal(), invoke);
  await c; expect(invoke).toHaveBeenCalledTimes(2);
  first.resolve(ok); await Promise.all([a, b]); expect(invoke).toHaveBeenCalledTimes(3);
});

it("cancellation does not release an unfinished native invocation or run stale queued work", async () => {
  const first = gate<IdxCommandResult>(), started = gate<void>();
  const invoke = vi.fn().mockImplementationOnce(() => { started.resolve(); return first.promise; }).mockResolvedValue(ok);
  const owner = new AbortController(), stale = new AbortController();
  const a = querySnapshot("/cancel", query, owner.signal, invoke); const canceled = expect(a).rejects.toBeDefined();
  await started.promise;
  const b = querySnapshot("/cancel", query, stale.signal, invoke); const skipped = expect(b).rejects.toBeDefined();
  stale.abort(); owner.abort(); await Promise.all([canceled, skipped]);
  const c = querySnapshot("/cancel", query, signal(), invoke);
  await Promise.resolve(); expect(invoke).toHaveBeenCalledTimes(1);
  first.resolve(ok); await c; expect(invoke).toHaveBeenCalledTimes(2);
});

it("retries only transient IDX lock failures, at most three attempts", async () => {
  const invoke = vi.fn().mockResolvedValueOnce(busy).mockRejectedValueOnce("Lock file is already being held").mockResolvedValue(ok);
  expect(await querySnapshot("/retry", query, signal(), invoke)).toEqual(ok);
  expect(invoke).toHaveBeenCalledTimes(3);
  invoke.mockReset().mockResolvedValue(busy);
  expect(await querySnapshot("/retry", query, signal(), invoke)).toEqual(busy);
  expect(invoke).toHaveBeenCalledTimes(3);
  invoke.mockReset().mockResolvedValue({ ...busy, stderr: "invalid option" });
  await querySnapshot("/retry", query, signal(), invoke); expect(invoke).toHaveBeenCalledTimes(1);
});

it("aborting backoff prevents further native attempts", async () => {
  const controller = new AbortController();
  const invoke = vi.fn(async () => { controller.abort(); return busy; });
  await expect(querySnapshot("/backoff", query, controller.signal, invoke)).rejects.toBeDefined();
  expect(invoke).toHaveBeenCalledTimes(1);
});
