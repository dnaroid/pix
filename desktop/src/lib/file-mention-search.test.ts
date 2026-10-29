import { afterEach, describe, expect, it, vi } from "vitest";
import { FileMentionSearch } from "../../../src/file-mention-search";
import type { FileMentionMatch } from "../../../src/file-mentions";

afterEach(() => vi.useRealTimers());
describe("file mention request ownership", () => {
  it("debounces rapid typing, aborts stale requests and drops late results after context change or teardown", async () => {
    vi.useFakeTimers();
    const pending: { resolve: (matches: FileMentionMatch[]) => void; signal: AbortSignal }[] = [];
    const request = vi.fn((_query: string, signal: AbortSignal) => new Promise<FileMentionMatch[]>((resolve) => pending.push({ resolve, signal })));
    const changed = vi.fn();
    const search = new FileMentionSearch(request, changed);
    search.observe("one", "a"); search.observe("two", "ab");
    await vi.advanceTimersByTimeAsync(80); expect(request).toHaveBeenCalledTimes(1);
    search.observe("new-session", "ab"); expect(pending[0]!.signal.aborted).toBe(true);
    pending[0]!.resolve([{ path: "old", directory: false }]); await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalledWith([{ path: "old", directory: false }], false, false);
    await vi.advanceTimersByTimeAsync(80);
    pending[1]!.resolve([{ path: "current", directory: true }]); await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenLastCalledWith([{ path: "current", directory: true }], false, false);
    search.observe("next", "next"); await vi.advanceTimersByTimeAsync(80);
    search.dispose(); pending[2]!.resolve([{ path: "late", directory: false }]); await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalledWith([{ path: "late", directory: false }], false, false);
  });
  it("reports a current failed query without reviving a dismissed list", async () => {
    vi.useFakeTimers(); const changed = vi.fn();
    const search = new FileMentionSearch(async () => { throw new Error("unavailable"); }, changed);
    search.observe("current", ""); await vi.advanceTimersByTimeAsync(80);
    expect(changed).toHaveBeenLastCalledWith([], false, true);
    search.observe("", ""); expect(changed).toHaveBeenLastCalledWith([], false, false);
    search.dispose();
  });
});
