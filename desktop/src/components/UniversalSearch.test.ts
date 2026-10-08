import { describe, expect, it } from "vitest";
import source from "./UniversalSearch.svelte?raw";
import { SEARCH_KINDS } from "../lib/universal-search";

describe("search category presentation", () => {
  it("distinguishes a successful empty search from sources with warnings or errors", () => {
    expect(source).toContain("'No results.'");
    expect(source).toContain("!result.results.length && notices.length");
    expect(source).toContain("searching && !result.results.length");
    expect(source).toContain("busy || !!result.pendingSources?.length");
    expect(source).toContain("aria-busy={searching}");
    expect(source).toContain('"git_search_history", { workspace, query }');
    expect(source).toContain("all ancestors of current HEAD");
    expect(source).not.toContain("latest 30");
    expect(source).toContain("No results. Check search details.");
  });
  it("keeps technical details collapsed and shows ongoing search beside partial results", () => {
    expect(source).toContain('<details class="mt-1">');
    expect(source).not.toContain("<details open");
    expect(source).toContain('role="status" aria-live="polite"');
    expect(source).toContain("{#if searching}<LoaderCircle");
    expect(source).toContain("Searching…");
    expect(source).toContain("pendingSearchNotice(source)");
  });
  it("owns voice input without extending the composer-only native shortcut", () => {
    expect(source).toContain('invoke<DeepgramToken>("deepgram_token")');
    expect(source).toContain('"Voice search" : "Stop voice input"');
    expect(source).toContain("await voice.stop()");
    expect(source).toContain("generation !== submissionGeneration");
    expect(source).toContain("requests !== currentRequests");
    expect(source).toContain("!disposed && generation === submissionGeneration) input.focus()");
    expect(source).toContain("generation === submissionGeneration && query === insertion.query");
    expect(source).toContain("voice?.dispose()");
    expect(source).toContain("voice?.cancel()");
    expect(source).not.toContain("attachDictationShortcut");
  });
  it("uses native hybrid queries and discloses their separate provider/index behavior", () => {
    expect(source).toContain('request: { workspace, query }');
    expect(source).not.toContain("snapshotOnly: true");
    expect(source).toContain("Local BM25");
    expect(source).toContain("IDX hybrid uses the project provider and may refresh the index");
    expect(source).toContain("client.searchCommits({ cwd, query, limit: 20 }, signal)");
    expect(source).toContain("Commits: BM25 + optional semantic search");
    expect(source).toContain("The saved IDX provider may receive commit messages and queries.");
  });
  it("shares theme-aware category colors between filters and result badges", () => {
    expect(source).toContain("data-search-kind={kind}");
    expect(source).toContain("data-search-kind={hit.kind}");
    const colors = SEARCH_KINDS.map(kind => {
      const match = source.match(new RegExp(`\\[data-search-kind="${kind}"\\] \\{ --category-color: var\\((--[\\w-]+)\\); \\}`));
      expect(match, kind).not.toBeNull();
      return match?.[1];
    });
    expect(new Set(colors).size).toBe(SEARCH_KINDS.length);
    expect(source).toContain(".search-category-badge {");
    expect(source).toContain("background: var(--category-color);");
  });

  it("keeps text labels and distinct selected, unselected and keyboard-focus states", () => {
    expect(source).toContain("aria-pressed={types.includes(kind)}");
    expect(source).toContain('.search-category-filter[aria-pressed="true"]');
    expect(source).toContain('.search-category-filter,');
    expect(source).toContain('color: var(--muted-foreground);');
    expect(source).toContain("{SEARCH_LABELS[hit.kind]}</span>");
    expect(source).toContain("focus-visible:outline-ring");
    expect(source).not.toContain("text-xs uppercase text-muted-foreground");
  });

  it("visibly hovers every found entity, including the active row, without overriding keyboard focus", () => {
    const results = source.slice(source.indexOf("{#each result.results as hit"), source.indexOf("{/each}", source.indexOf("{#each result.results as hit")));
    expect(results).toContain("data-search-result={index}");
    expect(results).toContain('data-active={index === active ? "true" : undefined}');
    expect(results).toContain('class="search-result ');
    expect(results).toContain("focus-visible:outline-ring");
    expect(source).toContain('.search-result[data-active="true"] {');
    expect(source).toContain("background: var(--panel-selected);");
    expect(source).toContain(".search-result:focus-visible {");
    expect(source).toContain("@media (hover: hover) {");
    expect(source).toContain(".search-result:hover:not(:disabled) {");
    expect(source).toContain("background: var(--panel-hover);");
    expect(source).toContain("box-shadow: inset 0 0 0 1px color-mix(");
    expect(source).toContain("rounded-md px-3 py-2");
    expect(source).not.toContain("border-left-color:");
    expect(source).not.toContain("onfocus={() => { active = index; }}");
    expect(source).toContain("let active = $state(-1)");
    expect(source).toContain("active = nextIndex >= 0 ? nextIndex : -1;");
    expect(source).toContain('event.key === "ArrowDown" ? 0 : length - 1');
    expect(source).toContain(".search-result:hover:not(:disabled) .search-category-badge {");
    expect(source).toContain("@media (prefers-reduced-motion: reduce) {");
    expect(results).not.toContain("hover:bg-chrome-hover");
    expect(results).not.toContain("bg-accent");
  });
});
