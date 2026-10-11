import { describe, expect, it, vi } from "vitest";
import { createSearchIndexActions, indexResultDetail, type IndexActions, type IndexResult } from "./search-index-actions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { resolve, promise };
}
describe("explicit per-source indexing", () => {
  it("does no work until clicked, isolates sources, and deduplicates repeated clicks", async () => {
    const code = deferred<IndexResult>();
    const states: IndexActions[] = [];
    const run = vi.fn((source: string) => source === "code" ? code.promise : Promise.resolve({ source: "tasks", complete: true } as IndexResult));
    const onSettled = vi.fn();
    const actions = createSearchIndexActions({ run, onChange: state => states.push(state), onSettled });
    expect(run).not.toHaveBeenCalled();
    const first = actions.start("code");
    await actions.start("code");
    await actions.start("tasks");
    expect(run).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toMatchObject({ code: { running: true }, tasks: { running: false, result: { complete: true } } });
    code.resolve({ source: "code", complete: false, indexed: 128, total: 900 });
    await first;
    expect(indexResultDetail(states.at(-1)?.code)).toContain("128/900");
    expect(onSettled).toHaveBeenCalledTimes(2);
    actions.dispose();
  });
  it("aborts on teardown and ignores late completions and new starts", async () => {
    const pending = deferred<IndexResult>();
    const run = vi.fn(() => pending.promise);
    const onChange = vi.fn(), onSettled = vi.fn();
    const actions = createSearchIndexActions({ run, onChange, onSettled });
    const job = actions.start("sessions");
    actions.dispose();
    expect((run.mock.calls[0] as unknown as [string, AbortSignal])[1].aborted).toBe(true);
    pending.resolve({ source: "sessions", complete: true });
    await job;
    await actions.start("tasks");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("discards results from the previous configuration", async () => {
    const pending = deferred<IndexResult>();
    const onChange = vi.fn();
    const actions = createSearchIndexActions({ run: () => pending.promise, onChange, onSettled: () => {} });
    const job = actions.start("knowledge");
    actions.reset();
    pending.resolve({ source: "knowledge", complete: true });
    await job;
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.lastCall?.[0]).toEqual({});
  });
  it("keeps cancellation and failures visible without retrying automatically", async () => {
    const pending = deferred<IndexResult>();
    const onChange = vi.fn();
    const run = vi.fn().mockReturnValueOnce(pending.promise).mockRejectedValue(new Error("secret provider payload"));
    const actions = createSearchIndexActions({ run, onChange, onSettled: () => {} });
    const job = actions.start("code");
    actions.cancel("code");
    pending.resolve({ source: "code", complete: true });
    await job;
    expect(onChange.mock.lastCall?.[0].code.error).toContain("stopped");
    await actions.start("code");
    expect(onChange.mock.lastCall?.[0].code.error).toContain("unavailable");
    expect(onChange.mock.lastCall?.[0].code.error).not.toContain("secret");
    expect(run).toHaveBeenCalledTimes(2);
    actions.dispose();
  });
});
