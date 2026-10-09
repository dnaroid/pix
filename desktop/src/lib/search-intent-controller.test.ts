import { describe, expect, it, vi } from "vitest";
import { SearchIntentController } from "./search-intent-controller";
import type { SearchIntentResponse } from "../../../acp/src/search/contract";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("Auto Jev request ownership", () => {
  it("allows valid decisions and fails closed on provider error", async () => {
    const controller = new SearchIntentController();
    expect(await controller.classify(async () => ({ intent: "ask", fallback: false })))
      .toEqual({ intent: "ask", fallback: false });
    expect(await controller.classify(async () => { throw new Error("private provider response"); }))
      .toEqual({ intent: "search", fallback: true });
  });
  it("does not publish a cancelled, delayed Ask after an edit or dialog close", async () => {
    const controller = new SearchIntentController();
    const first = deferred<SearchIntentResponse>();
    let firstSignal!: AbortSignal;
    const pending = controller.classify(signal => { firstSignal = signal; return first.promise; });
    controller.cancel();
    expect(firstSignal.aborted).toBe(true);
    first.resolve({ intent: "ask", fallback: false });
    await expect(pending).resolves.toBeUndefined();
  });
  it("only the latest classification may own the result", async () => {
    const controller = new SearchIntentController();
    const old = deferred<SearchIntentResponse>();
    const pending = controller.classify(() => old.promise);
    const latest = controller.classify(async () => ({ intent: "search", fallback: false }));
    old.resolve({ intent: "ask", fallback: false });
    await expect(pending).resolves.toBeUndefined();
    await expect(latest).resolves.toEqual({ intent: "search", fallback: false });
  });
  it("no unhandled stale failure and no unexpected retries", async () => {
    const controller = new SearchIntentController();
    const old = deferred<SearchIntentResponse>();
    const request = vi.fn(() => old.promise);
    const pending = controller.classify(request);
    controller.cancel();
    old.reject(new Error("late failure"));
    await expect(pending).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
