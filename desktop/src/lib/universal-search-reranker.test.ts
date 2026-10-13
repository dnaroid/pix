import { afterEach, describe, expect, it, vi } from "vitest";
import { queryUniversalSearch, SEARCH_KINDS, type SearchSources, type UnifiedSearchResult } from "./universal-search";

afterEach(() => vi.useRealTimers());
const selection = async () => ({ enabled: Object.fromEntries(SEARCH_KINDS.map(kind => [kind, true])) as Record<typeof SEARCH_KINDS[number], boolean> });
const code = { kind: "code" as const, id: "c", title: "needle needle", snippet: "needle", path: "owner.ts", startLine: 1, endLine: 2, score: 0.8, content: "needle code" };
const knowledge = { ...code, kind: "knowledge" as const, id: "k", path: "guide.md", score: 0.2 };
function sources(): SearchSources {
  return { selection,
    prepareRerank: vi.fn(async (_root, kinds) => ({ context: { signature: "config", policyRevision: "policy", sources: kinds, history: { sessions: "s", tasks: "t", commits: "g" } } })),
    rerank: vi.fn(async (_root, request) => ({ notices: [], order: [...request.candidates].reverse().map((hit, i) => ({ kind: hit.kind, id: hit.id, score: 1 - i / request.candidates.length })) })),
    repository: vi.fn<NonNullable<SearchSources["repository"]>>(async () => ({ hits: [code, knowledge], notices: [], rerankContext: { code: { generation: 1, hashes: { "owner.ts": "hash" } } },
      status: { backend: "native", complete: true, stale: false, generation: 1, semanticEnabled: false, rerankerEnabled: true } })),
    local: vi.fn<NonNullable<SearchSources["local"]>>(async () => ({ results: [{ kind: "sessions", id: "s", sessionId: "session", title: "needle session", snippet: "needle", score: 0.5 }], notices: [], status: { enabled: false, keyAvailable: false, indexing: false } })),
    tasks: async () => ({ version: 1, tasks: [{ id: "t", title: "needle task", description: "needle", type: "feature", status: "todo", priority: "medium", createdAt: "2026-01-01", updatedAt: "2026-01-01" }] }),
    commits: async () => [{ hash: "a".repeat(40), shortHash: "aaaaaaa", subject: "needle commit", author: "Fixture", date: "2026-01-01" }],
  };
}
const run = (adapters: SearchSources, updates?: (result: UnifiedSearchResult) => void, signal = new AbortController().signal) =>
  queryUniversalSearch(adapters, "/repo", "needle", ["sessions", "tasks", "commits", "code", "knowledge"], [], signal, updates);

describe("universal federated reranking", () => {
  it("publishes local matches then applies one provider order across all sources, without native double rerank", async () => {
    const adapters = sources(), updates = vi.fn(); const result = await run(adapters, updates);
    expect(adapters.rerank).toHaveBeenCalledTimes(1); const request = vi.mocked(adapters.rerank!).mock.calls[0]![1];
    expect(new Set(request.candidates.map(hit => hit.kind))).toEqual(new Set(["sessions", "tasks", "commits", "code", "knowledge"]));
    expect(request.nativeContext?.code?.generation).toBe(1);
    expect(result.results.map(hit => hit.id)).toEqual([...request.candidates].reverse().map(hit => hit.id));
    expect(updates.mock.calls.some(([value]) => value.results.length && value.results.map((hit: any) => hit.id).join() !== result.results.map(hit => hit.id).join())).toBe(true);
    expect(adapters.repository).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adapters.repository!).mock.calls[0]![1]).toMatchObject({ mode: "lexical", skipRerank: true, limit: 100 });
  });
  it("settings are never uploaded and remain in their local slots", async () => {
    const adapters = sources(); adapters.local = async () => ({ results: [{ kind: "settings", id: "set", fieldId: "f", section: "s", title: "needle", snippet: "needle", score: 0.8 }], notices: [], status: { enabled: false, keyAvailable: false, indexing: false } });
    const updates = vi.fn(); const result = await queryUniversalSearch(adapters, "/repo", "needle", ["settings", "code", "knowledge"], [], new AbortController().signal, updates);
    const request = vi.mocked(adapters.rerank!).mock.calls[0]![1]; expect(request.candidates.every(hit => (hit.kind as string) !== "settings")).toBe(true);
    const previous = updates.mock.calls.at(-2)![0].results;
    expect(result.results.findIndex(hit => hit.kind === "settings")).toBe(previous.findIndex((hit: any) => hit.kind === "settings"));
  });
  it("waits for late sources before the single final rerank", async () => {
    vi.useFakeTimers(); const adapters = sources(), updates = vi.fn(); let release!: (value: Awaited<ReturnType<NonNullable<SearchSources["commits"]>>>) => void;
    adapters.commits = () => new Promise(resolve => { release = resolve; });
    const initial = run(adapters, updates); await vi.advanceTimersByTimeAsync(20000);
    expect((await initial).pendingSources).toContain("Commits"); expect(adapters.rerank).not.toHaveBeenCalled();
    release([{ hash: "b".repeat(40), shortHash: "bbbbbbb", subject: "needle late", author: "Fixture", date: "2026-01-01" }]);
    await vi.advanceTimersByTimeAsync(0); expect(adapters.rerank).toHaveBeenCalledTimes(1);
    expect(updates.mock.calls.at(-1)![0].pendingSources).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it("failed or malformed reranking keeps local results", async () => {
    for (const rerank of [async () => ({ notices: ["fallback"] }), async () => ({ order: [], notices: [] }), async () => { throw new Error("SECRET_BODY"); }]) {
      const adapters = sources(); adapters.rerank = rerank;
      const result = await run(adapters); expect(result.results).toHaveLength(5); expect(result.notices.join()).not.toContain("SECRET_BODY");
    }
  });
  it("bounds ignored preparation abort and never enables a late context", async () => {
    vi.useFakeTimers(); const adapters = sources(); let release!: (value: any) => void;
    adapters.prepareRerank = vi.fn<NonNullable<SearchSources["prepareRerank"]>>(() => new Promise(resolve => { release = resolve; }));
    const pending = run(adapters); await vi.advanceTimersByTimeAsync(4000);
    expect((await pending).results).toHaveLength(5); expect(adapters.rerank).not.toHaveBeenCalled();
    release({ context: { sources: ["code"] } }); await vi.advanceTimersByTimeAsync(0);
    expect(adapters.rerank).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("discards timed-out and cancelled remote completions without late publication", async () => {
    vi.useFakeTimers();
    for (const cancel of [false, true]) {
      const adapters = sources(), updates = vi.fn(), caller = new AbortController(); let release!: (value: any) => void;
      adapters.rerank = vi.fn<NonNullable<SearchSources["rerank"]>>(() => new Promise(resolve => { release = resolve; })); const pending = run(adapters, updates, caller.signal);
      await vi.advanceTimersByTimeAsync(0); if (cancel) caller.abort(); else await vi.advanceTimersByTimeAsync(4500);
      const result = await pending; const count = updates.mock.calls.length;
      if (!cancel) expect(result.notices.join()).toContain("original ranking retained");
      release({ order: [], notices: [] }); await vi.advanceTimersByTimeAsync(0);
      expect(updates).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
    }
  });
});
