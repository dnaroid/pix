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
  it("blocks disabled sources, serializes saves, cancels that manual source and retains selection on save error", async () => {
    vi.useFakeTimers();
    let state = emptySearchIndexView();
    const enabled = { settings: true, code: true, knowledge: false, tasks: false, sessions: false, commits: false };
    const write = deferred<{ enabled: typeof enabled }>();
    const setSource = vi.fn(() => write.promise);
    const run = vi.fn<Parameters<typeof createSearchIndexController>[0]["run"]>(async (_source, signal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { source: "code", complete: true };
    });
    const controller = createSearchIndexController({ readStores: async () => ({ stores: [] }),
      readConsent: async () => ({ configured: false, keyAvailable: false, provider: "openrouter", model: "", vectorSize: 0 }), readSelection: async () => ({ enabled }),
      setSource, run, onChange: next => { state = next; } });
    await vi.advanceTimersByTimeAsync(0);
    controller.start("knowledge"); expect(run).not.toHaveBeenCalled();
    controller.start("code"); await vi.advanceTimersByTimeAsync(0);
    const saving = controller.setSource("code", false);
    await controller.setSource("tasks", true);
    expect(setSource).toHaveBeenCalledTimes(1); expect(state.savingSource).toBe("code");
    enabled.code = false; write.resolve({ enabled }); await saving;
    expect(state.actions.code?.result).toBeUndefined(); expect(state.snapshot.selection?.enabled.code).toBe(false);
    setSource.mockRejectedValueOnce(new Error("save failed")); await controller.setSource("tasks", true);
    expect(state.snapshot.selection?.enabled.tasks).toBe(false); expect(state.snapshot.selectionError).toBe("save failed");
    controller.dispose();
  });
  it("re-reads source selection after config changes and saves, not on every poll", async () => {
    vi.useFakeTimers();
    const enabled = { settings: true, code: true, knowledge: false, tasks: false, sessions: false, commits: false };
    const readSelection = vi.fn(async () => ({ enabled: { ...enabled } }));
    const setSource = vi.fn(async () => ({ enabled: { ...enabled, tasks: true } }));
    const controller = createSearchIndexController({ readStores: async () => ({ stores: [] }),
      readConsent: async () => ({ configured: true, keyAvailable: true, provider: "ollama", model: "m", vectorSize: 3 }),
      readSelection, setSource, run: vi.fn(), onChange: vi.fn() });
    await vi.advanceTimersByTimeAsync(30_000 * 1.5);
    expect(readSelection).toHaveBeenCalledOnce();
    controller.configChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(readSelection).toHaveBeenCalledTimes(2);
    await controller.setSource("tasks", true);
    expect(readSelection).toHaveBeenCalledTimes(3);
    controller.dispose();
  });
  it("does not build a separate activity log while indexing, and keeps manual outcomes", async () => {
    vi.useFakeTimers();
    const pending = deferred<IndexResult>();
    const f = fixture(vi.fn(() => pending.promise));
    await vi.advanceTimersByTimeAsync(0);
    f.controller.start("code");
    expect("history" in f.state()).toBe(false);
    expect(f.state().actions.code?.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect("history" in f.state()).toBe(false);
    pending.resolve({ source: "code", complete: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state().actions.code?.result?.complete).toBe(true);
    f.controller.dispose();
    const count = f.onChange.mock.calls.length;
    f.controller.refresh();
    expect(f.onChange).toHaveBeenCalledTimes(count);
  });
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
