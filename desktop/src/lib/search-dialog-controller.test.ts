import { afterEach, describe, expect, it, vi } from "vitest";
import source from "../components/UniversalSearch.svelte?raw";
import { emptySearchDialogState, SearchDialogController, searchStatusLabel, type SearchDialogState } from "./search-dialog-controller";
import type { SearchStatus } from "../../../acp/src/search/contract";
import type { UnifiedSearchResult } from "./universal-search";

const result = (id: string): UnifiedSearchResult => ({ idxAvailable: false, notices: [], results: [
  { kind: "settings", id, title: id, snippet: "", score: 1, section: "desktop-assistant", fieldId: id },
] });
const status: SearchStatus = { enabled: false, keyAvailable: true, indexing: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const controllers: SearchDialogController[] = [];
function setup(search = vi.fn().mockResolvedValue(result("first")), readStatus = vi.fn().mockResolvedValue(status)) {
  let state = emptySearchDialogState();
  const publish = vi.fn((next: SearchDialogState) => { state = next; });
  const controller = new SearchDialogController(search, readStatus, publish, 50);
  controllers.push(controller);
  return { controller, search, readStatus, publish, state: () => state };
}
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.useRealTimers(); });

describe("explicit search dialog requests", () => {
  it("semantic status identifies each independent consent without claiming all session titles are sent", () => {
    const label = searchStatusLabel({ ...status, enabled: true });
    expect(label).toBe("Semantic settings search enabled · session titles require separate opt-in");
    expect(label).not.toContain("settings stay local");
    expect(searchStatusLabel({ ...status, sessionTitlesEnabled: true }))
      .toBe("Semantic session-title search enabled · conversation history stays local");
    expect(searchStatusLabel({ ...status, enabled: true, sessionTitlesEnabled: true }))
      .toBe("Semantic settings + session-title search enabled · history stays local");
  });

  it("opening, editing and polling status never submit search", async () => {
    vi.useFakeTimers();
    const s = setup();
    s.controller.start();
    s.controller.invalidate();
    await vi.advanceTimersByTimeAsync(180);
    expect(s.readStatus.mock.calls.length).toBeGreaterThan(1);
    expect(s.search).not.toHaveBeenCalled();
    expect(s.state().status).toEqual(status);
    expect(s.state().submitted).toBe(false);
  });

  it("only a valid submit runs a query with a type snapshot", async () => {
    const s = setup();
    await s.controller.submit("  ", ["sessions"]);
    await s.controller.submit("hello", []);
    expect(s.search).not.toHaveBeenCalled();
    const types: ("sessions" | "settings")[] = ["sessions"];
    const submitted = s.controller.submit(" hello ", types);
    types.push("settings");
    await submitted;
    expect(s.search).toHaveBeenCalledExactlyOnceWith("hello", ["sessions"], expect.any(AbortSignal), expect.any(Function));
    expect(s.state().submitted).toBe(true);
    expect(s.state().result).toEqual(result("first"));
  });

  it("editing cancels and clears results without allowing late publication", async () => {
    const pending = deferred<UnifiedSearchResult>();
    const s = setup(vi.fn().mockReturnValue(pending.promise));
    const submitted = s.controller.submit("old", ["sessions"]);
    const signal = s.search.mock.calls[0]![2] as AbortSignal;
    s.controller.invalidate();
    pending.resolve(result("obsolete"));
    await submitted;
    expect(signal.aborted).toBe(true);
    expect(s.state().busy).toBe(false);
    expect(s.state().submitted).toBe(false);
    expect(s.state().result.results).toEqual([]);
  });

  it("keeps a pending submission owned after initial waiting and accepts its final update", async () => {
    const partial = { ...result("fast"), pendingSources: ["Tasks"] };
    const s = setup(vi.fn().mockResolvedValue(partial));
    await s.controller.submit("theme", ["tasks"]);
    const signal = s.search.mock.calls[0]![2] as AbortSignal;
    const update = s.search.mock.calls[0]![3] as (next: UnifiedSearchResult) => void;
    expect(s.state().busy).toBe(false);
    expect(signal.aborted).toBe(false);
    update(result("late"));
    expect(s.state().result).toEqual(result("late"));
    expect(s.state().busy).toBe(false);
  });

  it.each(["edit", "resubmit", "dispose"])("ignores late callbacks after %s and cancels pending sources", async action => {
    const s = setup(vi.fn().mockResolvedValue({ ...result("fast"), pendingSources: ["Tasks"] }));
    await s.controller.submit("old", ["tasks"]);
    const signal = s.search.mock.calls[0]![2] as AbortSignal;
    const update = s.search.mock.calls[0]![3] as (next: UnifiedSearchResult) => void;
    if (action === "edit") s.controller.invalidate();
    if (action === "resubmit") await s.controller.submit("new", ["settings"]);
    if (action === "dispose") s.controller.dispose();
    const published = JSON.stringify(s.state());
    update(result("obsolete"));
    expect(signal.aborted).toBe(true);
    expect(JSON.stringify(s.state())).toBe(published);
  });

  it("a replaced submission ignores an older noncooperative completion", async () => {
    const old = deferred<UnifiedSearchResult>();
    const s = setup(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(result("new")));
    const first = s.controller.submit("old", ["sessions"]);
    await s.controller.submit("new", ["settings"]);
    old.resolve(result("old"));
    await first;
    expect(s.state().result).toEqual(result("new"));
  });

  it("cancellation settles even if the search source never cooperates", async () => {
    const late = deferred<UnifiedSearchResult>();
    const s = setup(vi.fn().mockReturnValue(late.promise));
    const submitted = s.controller.submit("old", ["sessions"]);
    s.controller.invalidate();
    await submitted;
    expect(s.state().busy).toBe(false);
    late.reject(new Error("late provider failure"));
    await Promise.resolve();
    expect(s.state().result.notices).toEqual([]);
  });

  it("status refresh does not change search results", async () => {
    vi.useFakeTimers();
    const s = setup();
    s.controller.start();
    await s.controller.submit("first", ["settings"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.search).toHaveBeenCalledTimes(1);
    expect(s.state().result).toEqual(result("first"));
    expect(searchStatusLabel(s.state().status)).toContain("Local search · semantic search is opt-in");
  });

  it("teardown aborts both requests and ignores delayed status and query", async () => {
    vi.useFakeTimers();
    const query = deferred<UnifiedSearchResult>();
    const poll = deferred<SearchStatus>();
    const s = setup(vi.fn().mockReturnValue(query.promise), vi.fn().mockReturnValue(poll.promise));
    s.controller.start();
    const submitted = s.controller.submit("first", ["settings"]);
    s.controller.dispose();
    const count = s.publish.mock.calls.length;
    expect(s.search.mock.calls[0]![2].aborted).toBe(true);
    expect(s.readStatus.mock.calls[0]![0].aborted).toBe(true);
    poll.resolve(status); query.resolve(result("late"));
    await submitted;
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.publish).toHaveBeenCalledTimes(count);
    expect(s.readStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a noncooperative status request times out and retries without query", async () => {
    vi.useFakeTimers();
    const old = deferred<SearchStatus>();
    const s = setup(undefined, vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(status));
    s.controller.start();
    await vi.advanceTimersByTimeAsync(8001);
    expect(s.state().statusError).toContain("Retrying");
    await vi.advanceTimersByTimeAsync(50);
    expect(s.state().status).toEqual(status);
    old.resolve({ ...status, enabled: true });
    await Promise.resolve();
    expect(s.state().status?.enabled).toBe(false);
    expect(s.search).not.toHaveBeenCalled();
  });

  it("unexpected query errors are bounded and never show provider secrets", async () => {
    const s = setup(vi.fn().mockRejectedValue(new Error("Bearer PRIVATE")));
    await s.controller.submit("first", ["sessions"]);
    expect(s.state().busy).toBe(false);
    expect(JSON.stringify(s.state())).not.toContain("PRIVATE");
    expect(s.state().result.notices).toEqual(["Search failed. Please try again."]);
  });

  it("the Svelte form wires button/Enter to submit and edits to invalidate", () => {
    expect(source).toContain('<form onsubmit=');
    expect(source).toContain('type="submit"');
    expect(source).toContain('event.key === "Enter" && event.target === input');
    expect(source).toContain("oninput={() => invalidate()}");
    expect(source).toContain("currentRequests?.submit(query, types)");
    expect(source).toContain("searchStatusLabel(status)");
    expect(source).not.toContain("}, 180)");
    expect(source).not.toContain("void choose(hit); }");
  });

  it("coverage warnings are displayed separately without rerunning search", async () => {
    const partial: SearchStatus = { ...status, warning: "Some session titles could not be searched" };
    const s = setup(undefined, vi.fn().mockResolvedValue(partial));
    s.controller.start();
    await vi.waitFor(() => expect(s.state().status?.warning).toBe(partial.warning));
    expect(searchStatusLabel(partial)).toContain("Local search");
    expect(source).toContain("{#if status?.warning}<p>{status.warning}</p>{/if}");
    expect(source).not.toContain("status?.filter");
    expect(s.search).not.toHaveBeenCalled();
  });
});
