import { describe, expect, it, vi } from "vitest";
import { queryUniversalSearch, SEARCH_KINDS, type SearchSources } from "./universal-search";

const nativeResponse = {
  hits: [{ kind: "code" as const, id: "code:src/a.ts", title: "src/a.ts", snippet: "needle", score: 0.8, path: "src/a.ts", startLine: 2, endLine: 3 }],
  notices: [],
  status: { backend: "native" as const, complete: true, stale: false, generation: 1 },
};

describe("universal native search", () => {
  it("retains all search kinds and uses native Code/Knowledge without an external fallback", async () => {
    expect(SEARCH_KINDS).toEqual(["settings", "sessions", "tasks", "commits", "code", "knowledge"]);
    const repository = vi.fn(async () => nativeResponse);
    const sources: SearchSources = { repository };
    const result = await queryUniversalSearch(sources, "/repo", "needle", ["code", "knowledge"], [], new AbortController().signal);

    expect(repository).toHaveBeenCalledWith("/repo", {
      query: "needle", sources: ["code", "knowledge"], mode: "lexical", limit: 30, includeContent: true,
    }, expect.any(AbortSignal));
    expect(result.results).toEqual(nativeResponse.hits);
    expect(result.notices).toEqual([]);
    expect(sources).not.toHaveProperty("overview");
    expect(sources).not.toHaveProperty("index");
  });

  it("shows actionable configuration guidance on native failure without an IDX fallback", async () => {
    const repository = vi.fn(async () => { throw new Error("unconfigured"); });
    const result = await queryUniversalSearch({ repository }, "/repo", "needle", ["code"], [], new AbortController().signal);

    expect(repository).toHaveBeenCalledTimes(1);
    expect(result.notices).toContain("Native Code/Knowledge search is unavailable. Configure this project's native search settings and retry.");
    expect(result.results).toEqual([]);
  });

  it("routes explicit patch queries only to commit sources", async () => {
    const repository = vi.fn(async () => nativeResponse);
    const commitHybrid = vi.fn(async () => ({ results: [], notices: [] }));
    const result = await queryUniversalSearch({ repository, commitHybrid }, "/repo", "patch:needle", ["code", "commits"], [], new AbortController().signal);

    expect(repository).not.toHaveBeenCalled();
    expect(commitHybrid).toHaveBeenCalledWith("/repo", "patch:needle", expect.any(AbortSignal));
    expect(result.results).toEqual([]);
  });
});
