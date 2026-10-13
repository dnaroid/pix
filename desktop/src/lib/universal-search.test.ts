import { afterEach, describe, expect, it, vi } from "vitest";
import { queryUniversalSearch, SEARCH_KINDS, type SearchSources } from "./universal-search";
const allSources = async () => ({ enabled: Object.fromEntries(SEARCH_KINDS.map(kind => [kind, true])) as Record<typeof SEARCH_KINDS[number], boolean> });
afterEach(() => vi.useRealTimers());

const nativeResponse = {
  hits: [{ kind: "code" as const, id: "code:src/a.ts", title: "src/a.ts", snippet: "needle", score: 0.8, path: "src/a.ts", startLine: 2, endLine: 3 }],
  notices: [],
  status: { backend: "native" as const, complete: true, stale: false, generation: 1 },
};

describe("universal native search", () => {
  it("publishes lexical results first then reranks even without configured embeddings", async () => {
    const reranked = { ...nativeResponse.hits[0]!, id: "code:src/b.ts", path: "src/b.ts", score: 0.99 };
    const repository = vi.fn<NonNullable<SearchSources["repository"]>>(async (_root, request) => ({
      ...nativeResponse, hits: request.mode === "hybrid" ? [reranked] : nativeResponse.hits,
      status: { ...nativeResponse.status, semanticEnabled: false, rerankerEnabled: true },
    }));
    const onUpdate = vi.fn();
    const result = await queryUniversalSearch({ repository, selection: allSources }, "/repo", "needle", ["code"], [], new AbortController().signal, onUpdate);
    expect(repository.mock.calls.map(call => call[1].mode)).toEqual(["lexical", "hybrid"]);
    expect(onUpdate.mock.calls.some(call => call[0].results[0]?.id === nativeResponse.hits[0]!.id)).toBe(true);
    expect(result.results).toEqual([reranked]);
  });
  it("retains all search kinds and uses native Code/Knowledge without an external fallback", async () => {
    expect(SEARCH_KINDS).toEqual(["settings", "sessions", "tasks", "commits", "code", "knowledge"]);
    const repository = vi.fn(async () => nativeResponse);
    const sources: SearchSources = { repository, selection: allSources };
    const result = await queryUniversalSearch(sources, "/repo", "needle", ["code", "knowledge"], [], new AbortController().signal);

    expect(repository).toHaveBeenCalledWith("/repo", {
      query: "needle", sources: ["code", "knowledge"], mode: "lexical", limit: 30, includeContent: true,
    }, expect.any(AbortSignal));
    expect(result.results).toEqual(nativeResponse.hits);
    expect(result.notices).toEqual([]);
    expect(sources).not.toHaveProperty("overview");
    expect(sources).not.toHaveProperty("index");
  });

  it("shows diagnostic guidance on native failure without inventing a setup gate", async () => {
    const repository = vi.fn(async () => { throw new Error("unconfigured"); });
    const result = await queryUniversalSearch({ repository }, "/repo", "needle", ["code"], [], new AbortController().signal);

    expect(repository).toHaveBeenCalledTimes(1);
    expect(result.notices).toContain("Native Code/Knowledge search is unavailable. Retry the search or inspect Search indexes for diagnostics.");
    expect(result.results).toEqual([]);
  });

  it("routes explicit patch queries only to commit sources", async () => {
    const repository = vi.fn(async () => nativeResponse);
    const commitHybrid = vi.fn(async () => ({ results: [], notices: [] }));
    const result = await queryUniversalSearch({ repository, commitHybrid, selection: allSources }, "/repo", "patch:needle", ["code", "commits"], [], new AbortController().signal);

    expect(repository).not.toHaveBeenCalled();
    expect(commitHybrid).toHaveBeenCalledWith("/repo", "patch:needle", expect.any(AbortSignal));
    expect(result.results).toEqual([]);
  });
  it("defaults to Settings/Code and never dispatches disabled sources, including local fallbacks", async () => {
    const tasks = vi.fn<NonNullable<SearchSources["tasks"]>>(async () => ({ version: 1, tasks: [] })), commits = vi.fn(async () => []);
    const local = vi.fn<NonNullable<SearchSources["local"]>>(async () => ({ results: [], notices: [], status: { enabled: false, keyAvailable: false, indexing: false } }));
    const repository = vi.fn<NonNullable<SearchSources["repository"]>>(async () => nativeResponse);
    await queryUniversalSearch({ tasks, commits, local, repository }, "/repo", "needle", [...SEARCH_KINDS], [], new AbortController().signal);
    expect(tasks).not.toHaveBeenCalled(); expect(commits).not.toHaveBeenCalled();
    expect(local.mock.calls[0]?.[0].types).toEqual(["settings"]);
    expect(repository.mock.calls[0]?.[1].sources).toEqual(["code"]);
  });
  it("all-off or unreadable policy invokes no data adapters", async () => {
    const repository = vi.fn(async () => nativeResponse), tasks = vi.fn<NonNullable<SearchSources["tasks"]>>(async () => ({ version: 1, tasks: [] }));
    const off = Object.fromEntries(SEARCH_KINDS.map(kind => [kind, false])) as Record<typeof SEARCH_KINDS[number], boolean>;
    const result = await queryUniversalSearch({ repository, tasks, selection: async () => ({ enabled: off }) }, "/repo", "needle", [...SEARCH_KINDS], [], new AbortController().signal);
    expect(result.results).toEqual([]); expect(repository).not.toHaveBeenCalled(); expect(tasks).not.toHaveBeenCalled();
    const failed = await queryUniversalSearch({ repository, selection: async () => { throw new Error("read"); } }, "/repo", "needle", ["code"], [], new AbortController().signal);
    expect(failed.notices.join(" ")).toContain("selection unavailable"); expect(repository).not.toHaveBeenCalled();
  });

  it("bounds a stuck source-selection prerequisite and never dispatches after its late completion", async () => {
    vi.useFakeTimers();
    let resolve!: (value: Awaited<ReturnType<typeof allSources>>) => void;
    const selection = vi.fn((_workspace: string, _signal: AbortSignal) => new Promise<Awaited<ReturnType<typeof allSources>>>(r => { resolve = r; }));
    const repository = vi.fn(async () => nativeResponse), onUpdate = vi.fn();
    const pending = queryUniversalSearch({ selection, repository }, "/repo", "needle", ["code"], [], new AbortController().signal, onUpdate);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).notices).toContain("Search source selection unavailable; no sources were searched.");
    expect(selection.mock.calls[0]![1].aborted).toBe(true);
    resolve(await allSources());
    await vi.advanceTimersByTimeAsync(0);
    expect(repository).not.toHaveBeenCalled(); expect(onUpdate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels selection immediately even when its transport ignores abort", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const repository = vi.fn(async () => nativeResponse);
    const pending = queryUniversalSearch({ selection: () => new Promise(() => {}), repository }, "/repo", "needle", ["code"], [], caller.signal);
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    expect(await pending).toEqual({ results: [], notices: [] });
    expect(repository).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces invalid-policy diagnostics rather than silently presenting an empty search", async () => {
    const repository = vi.fn(async () => nativeResponse);
    const result = await queryUniversalSearch({ repository, selection: async () => ({ ...await allSources(), error: "invalid policy" }) },
      "/repo", "needle", ["code"], [], new AbortController().signal);
    expect(result.notices).toContain("Search source selection unavailable; no sources were searched.");
    expect(repository).not.toHaveBeenCalled();
  });
});
