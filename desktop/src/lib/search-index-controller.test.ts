import { afterEach, describe, expect, it, vi } from "vitest";
import { createSearchIndexController, emptySearchIndexView } from "./search-index-controller";
import type { IndexResult } from "./search-index-actions";
import type { SearchIndexStatus } from "./search-index-status";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { resolve, promise };
}
function fixture(run = vi.fn(async (): Promise<IndexResult> => ({ source: "code", complete: true }))) {
  let state = emptySearchIndexView();
  const readStores = vi.fn(async (): Promise<SearchIndexStatus> => ({ stores: [] }));
  const onChange = vi.fn(value => { state = value; });
  const controller = createSearchIndexController({ readStores,
    readConsent: async () => ({ configured: true, keyAvailable: true, provider: "ollama", model: "m", vectorSize: 3 }),
    run, onChange,
  });
  return { controller, readStores, run, onChange, state: () => state };
}
afterEach(() => vi.useRealTimers());

describe("workspace-owned search index controller", () => {
  it("shares one read-only timer while the panel is closed and does not index implicitly", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    f.controller.closePanel();
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.readStores).toHaveBeenCalledTimes(2);
    expect(f.run).not.toHaveBeenCalled();
    f.controller.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.readStores).toHaveBeenCalledTimes(2);
  });
  it("publishes manual activity immediately, speeds up reads and retains partial outcomes", async () => {
    vi.useFakeTimers();
    const pending = deferred<IndexResult>();
    const f = fixture(vi.fn(() => pending.promise));
    await vi.advanceTimersByTimeAsync(0);
    f.controller.start("code");
    expect(f.state().actions.code?.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.readStores).toHaveBeenCalledTimes(3);
    pending.resolve({ source: "code", complete: false, indexed: 128, total: 500 });
    await vi.advanceTimersByTimeAsync(0);
    f.controller.closePanel();
    expect(f.state().actions.code?.result?.complete).toBe(false);
    f.controller.dispose();
  });
  it("closing the panel aborts only manual work and never publishes late success", async () => {
    vi.useFakeTimers();
    const pending = deferred<IndexResult>();
    let signal!: AbortSignal;
    let state = emptySearchIndexView();
    const controller = createSearchIndexController({ readStores: async () => ({ stores: [] }),
      readConsent: async () => ({ configured: false, keyAvailable: false, provider: null, model: null, vectorSize: null }),
      readActivity: async () => ({ indexingSources: { tasks: true, settings: false, sessions: false } }),
      run: (_source, current) => { signal = current; return pending.promise; },
      onChange: value => { state = value; },
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.start("code");
    controller.closePanel();
    expect(signal.aborted).toBe(true);
    pending.resolve({ source: "code", complete: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.actions.code).toMatchObject({ running: false, cancelled: true });
    expect(state.snapshot.activity?.indexingSources?.tasks).toBe(true);
    controller.dispose();
  });
  it("configuration changes and workspace teardown fence old manual completions", async () => {
    vi.useFakeTimers();
    const pending = deferred<IndexResult>();
    const f = fixture(vi.fn(() => pending.promise));
    f.controller.start("code");
    f.controller.configChanged();
    expect(f.state().actions).toEqual({});
    f.controller.dispose();
    const count = f.onChange.mock.calls.length;
    pending.resolve({ source: "code", complete: true });
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.onChange).toHaveBeenCalledTimes(count);
    expect(f.state().actions).toEqual({});
  });
});
