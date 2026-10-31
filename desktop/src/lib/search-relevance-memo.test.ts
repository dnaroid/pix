import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "./universal-search";

const normalize = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("./search-query", async (original) => {
  const actual = await original<typeof import("./search-query")>();
  return {
    ...actual,
    normalizeSearchConcepts: (text: string) => { normalize.calls.push(text); return actual.normalizeSearchConcepts(text); },
  };
});
const { rankSearchHits } = await import("./search-relevance");

const code = (id: string, content: string): SearchHit => ({
  kind: "code", id: `code:${id}`, path: id, startLine: 1, endLine: 2, title: id, snippet: "Lines 1–2", score: 1, content,
});
const field = { id: "theme", section: "appearance", label: "Theme", description: "Color scheme", synonyms: ["dark"] };
const setting: SearchHit = { kind: "settings", id: "settings:theme", fieldId: "theme", section: "appearance", title: "Theme", snippet: "", score: 1 };

afterEach(() => { normalize.calls.length = 0; });

describe("search relevance memoization", () => {
  it("tokenizes each hit once across repeated re-ranks and only re-normalizes the query", () => {
    const hits = [code("src/a.ts", "export function alphaBeta() { return beta; }"), code("src/b.ts", "const gamma = alpha;")];
    const first = rankSearchHits(hits, "alpha", [], false).map(hit => hit.id);
    const firstCalls = normalize.calls.length;
    expect(firstCalls).toBe(1 + hits.length * 2);
    normalize.calls.length = 0;
    const second = rankSearchHits([...hits], "alpha", [], false).map(hit => hit.id);
    expect(second).toEqual(first);
    expect(normalize.calls).toEqual(["alpha"]);
    normalize.calls.length = 0;
    // A new query reuses hit terms too; scoring changes with the query.
    expect(rankSearchHits(hits, "gamma", [], false).map(hit => hit.id)).toEqual(["code:src/b.ts", "code:src/a.ts"]);
    expect(normalize.calls).toEqual(["gamma"]);
  });

  it("matches fresh-hit rankings, including partial previews and commit hash terms", () => {
    const commit: SearchHit = {
      kind: "commits", id: "commits:abcdef1", hash: "abcdef1234", title: "Fix parser", snippet: "",
      score: 1, commit: { hash: "abcdef1234", shortHash: "abcdef1", subject: "Fix parser", author: "Ann", date: "", refs: [] },
    } as unknown as SearchHit;
    const hits = [commit, code("src/parser.ts", "parser fix")];
    const clone = () => hits.map(hit => ({ ...hit })) as SearchHit[];
    for (const [query, partial] of [["abcdef1", false], ["pars", true], ["parser", false], ["abcdef1", false]] as const) {
      expect(rankSearchHits(hits, query, [], false, partial)).toEqual(rankSearchHits(clone(), query, [], false, partial));
    }
  });

  it("re-derives settings metadata when the authored field changes", () => {
    expect(rankSearchHits([setting], "dark", [field], false)).toEqual([setting]);
    expect(rankSearchHits([setting], "dark", [{ ...field, synonyms: ["light"] }], false)).toEqual([]);
    expect(rankSearchHits([setting], "dark", [field], false)).toEqual([setting]);
  });
});
