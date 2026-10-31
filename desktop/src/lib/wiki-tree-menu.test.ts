import { describe, expect, it, vi } from "vitest";
import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import type { WikiFinding } from "./wiki-conflicts-index";
import { wikiBranchReportLanguage, wikiTreeConflictMenuActions } from "./wiki-tree-menu";
import tree from "../components/ProjectWikiTree.svelte?raw";

const citation = (path: string, quote: string): KnowledgeCitation => ({ path, quote, startLine: 1, endLine: 1 });
const finding = (id: string, extra: Partial<WikiFinding> = {}): WikiFinding => ({
  id, kind: "conflict", internal: false,
  draft: citation("wiki/a.md", "Claim A."), existing: citation("wiki/b.md", "Claim B."),
  explanation: "Rules differ.", reportPath: "wiki/a.md", checkedAt: "2026-10-30T00:00:00.000Z",
  current: true, modelRef: "test/judge", reportPaths: ["wiki/a.md"], stale: false, decisionPartial: false, ...extra,
});

describe("Wiki tree conflict context menu", () => {
  it("opens Wiki Conflicts filtered to the row's project path", async () => {
    const open = vi.fn();
    const [action, ...rest] = wikiTreeConflictMenuActions("wiki/rules", "ru", open);
    expect(rest).toEqual([]);
    expect(action!.label).toBe("Разобрать противоречия");
    await action!.action();
    expect(open).toHaveBeenCalledExactlyOnceWith({ path: "wiki/rules" });
    expect(wikiTreeConflictMenuActions("wiki", undefined, open)[0]!.label).toBe("Review contradictions");
  });

  it("takes the label language from reports touching that branch", () => {
    const findings = [
      finding("en", { reportLanguage: "en" }),
      finding("ru", { reportLanguage: "ru", draft: citation("wiki/ru/x.md", "X."), existing: citation("wiki/ru/y.md", "Y.") }),
    ];
    expect(wikiBranchReportLanguage(findings, "wiki/ru")).toBe("ru");
    expect(wikiBranchReportLanguage(findings, "wiki/a.md")).toBe("en");
    expect(wikiBranchReportLanguage(findings, "docs")).toBeUndefined();
  });

  it("attaches the menu only to red rows and releases it with the tree", () => {
    expect(tree).toContain('oncontextmenu={checkSummary?.status === "conflicts" && conflictMenu');
    expect(tree).toContain("conflictMenu?.dispose()");
  });
});
