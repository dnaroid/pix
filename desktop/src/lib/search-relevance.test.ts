import { describe, expect, it } from "vitest";
import { rankSearchHits } from "./search-relevance";
import type { SearchHit } from "./universal-search";

function session(id: string, title: string, score = 0.5): SearchHit {
  return { kind: "sessions", id, sessionId: id, title, snippet: "", score };
}
const field = { id: "theme", section: "appearance", label: "Theme", description: "Color scheme", synonyms: ["dark"] };
const setting: SearchHit = { kind: "settings", id: "settings:theme", fieldId: "theme", section: "appearance", title: "Theme", snippet: "", score: 100 };
const file: SearchHit = { kind: "code", id: "code:src/a.ts:1", path: "src/a.ts", startLine: 1, endLine: 2, title: "src/a.ts", snippet: "Lines 1–2", score: 999 };

describe("local search relevance", () => {
  it("puts the screenshot's pi SDK session above unrelated settings and removes weak metadata hits", () => {
    const hits = [setting, session("good", "Обновление pi SDK", 0.1), session("noise", "pi quota", 900), session("substring", "Pix assistant sdk", 100), file];
    expect(rankSearchHits(hits, "обновилась pi sdk", [field], false).map(hit => hit.id)).toEqual(["good", "code:src/a.ts:1"]);
    expect(rankSearchHits(hits, "обновилась pi sdk", [field], true).map(hit => hit.id)).toEqual(["good", "settings:theme", "code:src/a.ts:1"]);
  });
  it("prefers exact titles, then title matches, then metadata; never compares cross-source scores", () => {
    const metadata = { ...setting, snippet: "alpha beta" };
    const hits = [metadata, file, session("long", "alpha beta discussion", 200), session("exact", "Alpha beta", 0.01)];
    expect(rankSearchHits(hits, "alpha beta", [], false).map(hit => hit.id)).toEqual(["exact", "long", "settings:theme", "code:src/a.ts:1"]);
  });
  it("normalizes Russian inflections, ё, English plurals, punctuation and identifier boundaries", () => {
    expect(rankSearchHits([session("ru", "Обновление PI SDK")], "обновилась, pi sdk!", [], false)).toHaveLength(1);
    expect(rankSearchHits([session("en", "SearchTask")], "search tasks", [], false)).toHaveLength(1);
    expect(rankSearchHits([session("yo", "Всё готово")], "все готово", [], false)).toHaveLength(1);
  });
  it("ignores stop words and uses distinct terms but preserves all-stop-word queries", () => {
    expect(rankSearchHits([session("sdk", "PI SDK")], "что с pi pi sdk", [], false)).toHaveLength(1);
    expect(rankSearchHits([session("stop", "the")], "the", [], false)).toHaveLength(1);
    expect(rankSearchHits([file], "...", [], false)).toEqual([]);
  });
  it("keeps authored synonyms and opaque content matches, rejects substring noise", () => {
    expect(rankSearchHits([setting, file], "dark", [field], false).map(hit => hit.id)).toEqual(["settings:theme", "code:src/a.ts:1"]);
    expect(rankSearchHits([session("pix", "Pix application")], "pi", [], false)).toEqual([]);
    expect(rankSearchHits([setting], "unrelated", [field], false)).toEqual([]);
  });
  it("keeps task IDs and commit hash prefixes", () => {
    const task: SearchHit = { kind: "tasks", id: "tasks:42", taskId: "42", title: "Fix search", snippet: "todo · feature · high", score: 1 };
    const hash = "abcdeff" + "0".repeat(33);
    const commit: SearchHit = { kind: "commits", id: `commits:${hash}`, hash, title: "Fix search", snippet: "", score: 1, commit: { hash, shortHash: hash.slice(0, 7), subject: "Fix search", author: "Alice", date: "2026-01-01" } };
    expect(rankSearchHits([task], "42", [], false)).toEqual([task]);
    expect(rankSearchHits([commit], "ABCDEFF", [], false)).toEqual([commit]);
    expect(rankSearchHits([commit], "Alice", [], false)).toEqual([commit]);
  });
  it("matches changed Git paths and retains backend patch evidence without filename terms", () => {
    const hash = "b".repeat(40);
    const commit = { hash, shortHash: "bbbbbbb", subject: "Neutral cleanup", author: "Ada", date: "2026-01-01",
      changedPaths: ["src/search/abortController.ts"] };
    const hit: SearchHit = { kind: "commits", id: `commits:${hash}`, hash, title: commit.subject,
      snippet: "Ada", score: 1, commit };
    expect(rankSearchHits([hit], "abortController", [], false)).toHaveLength(1);
    expect(rankSearchHits([hit], "sessionWorker", [], false)).toEqual([]);
    const patch: SearchHit = { ...hit, contentMatch: true };
    expect(rankSearchHits([patch], "patch:sessionWorker", [], false)).toEqual([patch]);
  });
  it("retains local first/final session excerpts when their matching terms are not visible in preview", () => {
    const hit: SearchHit = { kind: "sessions", id: "sessions:1", sessionId: "1",
      title: "Unrelated title", snippet: "First: small preview", boundaryMatch: true, score: 1 };
    expect(rankSearchHits([hit], "hidden text from final", [], false)).toEqual([hit]);
  });
  it("deduplicates, caps results and keeps ordering deterministic across asynchronous source completion", () => {
    const hits = Array.from({ length: 65 }, (_, i) => session(`session:${String(i).padStart(2, "0")}`, "Search", i));
    const result = rankSearchHits([...hits, hits[0]!], "search", [], false);
    expect(result).toHaveLength(60);
    expect(new Set(result.map(hit => hit.id)).size).toBe(60);
    expect(rankSearchHits([...hits].reverse(), "search", [], false)).toEqual(result);
  });
  it("retains full-message evidence outside commit metadata without duplicating native hits", () => {
    const hash = "a".repeat(40);
    const native: SearchHit = { kind: "commits", id: `commits:${hash}`, hash, title: "Documentation", snippet: "Alice · 2026-01-01", score: 1, commit: { hash, shortHash: hash.slice(0, 7), subject: "Documentation", author: "Alice", date: "2026-01-01" } };
    const indexed: SearchHit = { ...native, contentMatch: true };
    expect(rankSearchHits([native], "restore backups", [], false)).toEqual([]);
    expect(rankSearchHits([indexed, native], "restore backups", [], false)).toEqual([indexed]);
  });
  it("ranks Russian autocomplete documentation and settings above unrelated semantic Auto matches", () => {
    const autocomplete = { id: "autocomplete-model", section: "desktop-assistant", label: "Autocomplete model", description: "Model for inline completion", synonyms: ["автодополнение", "авто-пополнение"] };
    const auto = { id: "auto-by-default", section: "desktop-models", label: "Auto by default", description: "Start drafts in Auto.", synonyms: ["automatic"] };
    const hits: SearchHit[] = [
      { kind: "settings", id: "settings:auto-by-default", fieldId: auto.id, section: auto.section, title: auto.label, snippet: auto.description, score: 0.9 },
      { kind: "commits", id: "commits:" + "a".repeat(40), hash: "a".repeat(40), title: "Add auto thinking", snippet: "Developer", score: 0.9, semantic: true, commit: { hash: "a".repeat(40), shortHash: "aaaaaaa", subject: "Add auto thinking", author: "Developer", date: "2026-01-01" } },
      { kind: "knowledge", id: "knowledge:specs/desktop-autocomplete.md:3-5", path: "specs/desktop-autocomplete.md", startLine: 3, endLine: 5, title: "specs/desktop-autocomplete.md", snippet: "Lines 3–5", score: 0.8, content: "Inline prompt completion architecture and request handling" },
      { kind: "settings", id: "settings:autocomplete-model", fieldId: autocomplete.id, section: autocomplete.section, title: autocomplete.label, snippet: autocomplete.description, score: 0.3 },
    ];
    const ranked = rankSearchHits(hits, "как работает авто-пополнение?", [auto, autocomplete], true);
    expect(ranked.slice(0, 2).map(hit => hit.id).sort()).toEqual(["knowledge:specs/desktop-autocomplete.md:3-5", "settings:autocomplete-model"].sort());
    expect(ranked.findIndex(hit => hit.id === "settings:auto-by-default")).toBeGreaterThan(1);
    expect(ranked.findIndex(hit => hit.kind === "commits")).toBeGreaterThan(1);
  });
  it("uses the returned IDX body to rank an otherwise opaque matching file", () => {
    const matching: SearchHit = { ...file, id: "code:src/feature.ts:1", title: "src/feature.ts", score: 0.1, content: "Implement autocomplete requests and accept inline completions" };
    const unrelated: SearchHit = { ...file, id: "code:src/unrelated.ts:1", title: "src/unrelated.ts", score: 0.9 };
    expect(rankSearchHits([unrelated, matching], "autocomplete", [], false)[0]?.id).toBe(matching.id);
  });
});
