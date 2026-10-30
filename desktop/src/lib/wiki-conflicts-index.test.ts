import { describe, expect, it } from "vitest";
import type { KnowledgeCheckResult, KnowledgeCitation, KnowledgeConflict } from "../../../acp/src/knowledge/contract";
import type { SavedKnowledgeReport } from "../../../acp/src/knowledge/stamp";
import {
  filterWikiFindings,
  groupWikiFindings,
  mergeWikiFindings,
  projectWikiPageFindings,
  summarizeWikiFindings,
  wikiFindingId,
} from "./wiki-conflicts-index";

const cite = (path: string, quote: string, startLine = 1): KnowledgeCitation =>
  ({ path, quote, startLine, endLine: startLine + quote.split("\n").length - 1 });

const pair = (draft: KnowledgeCitation, existing: KnowledgeCitation, explanation = "incompatible"): KnowledgeConflict =>
  ({ draft, existing, explanation });

function report(
  path: string,
  conflicts: KnowledgeConflict[],
  options: { uncertainties?: KnowledgeConflict[]; current?: boolean; checkedAt?: string; status?: KnowledgeCheckResult["status"] } = {},
): SavedKnowledgeReport {
  return {
    current: options.current ?? true,
    checkedAt: options.checkedAt ?? "2026-10-01T00:00:00.000Z",
    result: {
      status: options.status ?? (conflicts.length ? "conflicts" : "incomplete"),
      path, documentHash: "0".repeat(64), modelRef: "test/judge", reportLanguage: "ru",
      checkedSources: 1, conflicts, notices: [],
      ...(options.uncertainties ? { uncertainties: options.uncertainties } : {}),
    },
  };
}

const A = "wiki/a.md", B = "wiki/b.md", C = "wiki/sub/c.md";

describe("wikiFindingId", () => {
  it("ignores side order, line numbers and line endings", async () => {
    const left = cite(A, "one\r\ntwo", 10), right = cite(B, "three", 40);
    const id = await wikiFindingId("conflict", left, right);
    expect(await wikiFindingId("conflict", cite(B, "three", 2), cite(A, "one\ntwo", 99))).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("distinguishes kind, quotations and paths", async () => {
    const id = await wikiFindingId("conflict", cite(A, "x"), cite(B, "y"));
    expect(await wikiFindingId("uncertainty", cite(A, "x"), cite(B, "y"))).not.toBe(id);
    expect(await wikiFindingId("conflict", cite(A, "x"), cite(B, "z"))).not.toBe(id);
    expect(await wikiFindingId("conflict", cite(A, "x"), cite(C, "y"))).not.toBe(id);
  });
});

describe("projectWikiPageFindings", () => {
  it("projects conflicts, uncertainties and internal findings of the reporting page", async () => {
    const findings = await projectWikiPageFindings(report(A, [
      pair(cite(A, "a1"), cite(B, "b1")),
      pair(cite(A, "a2"), cite(A, "a3")),
    ], { uncertainties: [pair(cite(A, "a4"), cite(C, "c1"), "missing scope")] }), A);
    expect(findings.map(finding => [finding.kind, finding.internal, finding.existing.path])).toEqual([
      ["conflict", false, B], ["conflict", true, A], ["uncertainty", false, C],
    ]);
    expect(findings[0]).toMatchObject({ reportPath: A, current: true, modelRef: "test/judge", reportLanguage: "ru" });
  });

  it("ignores reports for another path and findings grounded in another page", async () => {
    expect(await projectWikiPageFindings(report(B, [pair(cite(B, "b"), cite(A, "a"))]), A)).toEqual([]);
    expect(await projectWikiPageFindings(report(A, [pair(cite(B, "b"), cite(A, "a"))]), A)).toEqual([]);
  });

  it("deduplicates repeated findings within one report", async () => {
    const finding = pair(cite(A, "a", 1), cite(B, "b", 1));
    const moved = pair(cite(A, "a", 7), cite(B, "b", 9));
    expect(await projectWikiPageFindings(report(A, [finding, moved]), A)).toHaveLength(1);
  });

  it("keeps findings from incomplete reports", async () => {
    const findings = await projectWikiPageFindings(report(A, [], {
      status: "incomplete", uncertainties: [pair(cite(A, "a"), cite(B, "b"))],
    }), A);
    expect(findings).toHaveLength(1);
  });
});

describe("mergeWikiFindings", () => {
  it("merges A↔B and B↔A into one finding listing both reports", async () => {
    const fromA = await projectWikiPageFindings(report(A, [pair(cite(A, "a"), cite(B, "b"))], { checkedAt: "2026-10-01T00:00:00.000Z" }), A);
    const fromB = await projectWikiPageFindings(report(B, [pair(cite(B, "b"), cite(A, "a"))], { checkedAt: "2026-10-02T00:00:00.000Z" }), B);
    const { findings, truncated } = mergeWikiFindings([fromA, fromB]);
    expect(truncated).toBe(false);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reportPaths: [A, B], stale: false, reportPath: B });
  });

  it("prefers a current report over a newer stale one and is stale only when no report is current", async () => {
    const current = await projectWikiPageFindings(report(A, [pair(cite(A, "a"), cite(B, "b"))]), A);
    const stale = await projectWikiPageFindings(report(B, [pair(cite(B, "b"), cite(A, "a"))],
      { current: false, checkedAt: "2026-10-09T00:00:00.000Z" }), B);
    expect(mergeWikiFindings([stale, current]).findings[0]).toMatchObject({ reportPath: A, stale: false });
    expect(mergeWikiFindings([stale]).findings[0]).toMatchObject({ stale: true });
  });

  it("orders stale findings last and bounds the projection", async () => {
    const page = await projectWikiPageFindings(report(A, [
      pair(cite(A, "a1"), cite(B, "b1")), pair(cite(A, "a2"), cite(C, "c2")),
    ]), A);
    const stalePage = await projectWikiPageFindings(report(C, [pair(cite(C, "c9"), cite(B, "b9"))], { current: false }), C);
    const { findings } = mergeWikiFindings([stalePage, page]);
    expect(findings.map(finding => finding.stale)).toEqual([false, false, true]);
    expect(mergeWikiFindings([stalePage, page], 2)).toMatchObject({ truncated: true, findings: findings.slice(0, 2) });
  });
});

describe("filter, group and summarize", () => {
  async function sample() {
    const a = await projectWikiPageFindings(report(A, [
      pair(cite(A, "a1"), cite(B, "b1")), pair(cite(A, "a2"), cite(B, "b2")), pair(cite(A, "a3"), cite(A, "a4")),
    ], { uncertainties: [pair(cite(A, "a5"), cite(C, "c5"))] }), A);
    const c = await projectWikiPageFindings(report(C, [pair(cite(C, "c6"), cite(B, "b6"))], { current: false }), C);
    return mergeWikiFindings([a, c]).findings;
  }

  it("filters by kind, staleness and branch", async () => {
    const findings = await sample();
    expect(filterWikiFindings(findings, { kind: "uncertainty" })).toHaveLength(1);
    expect(filterWikiFindings(findings, { kind: "internal" })).toHaveLength(1);
    expect(filterWikiFindings(findings, { status: "stale" })).toHaveLength(1);
    expect(filterWikiFindings(findings, { branch: "wiki/sub/" })).toHaveLength(2);
    expect(filterWikiFindings(findings, { branch: "wiki/su" })).toHaveLength(0);
  });

  it("groups by document pair or by reporting page", async () => {
    const findings = await sample();
    const pairs = groupWikiFindings(findings, "pair");
    expect(pairs.map(group => [group.label, group.findings.length])).toEqual([
      [A, 1], ["a.md ↔ b.md", 2], ["a.md ↔ c.md", 1], ["b.md ↔ c.md", 1],
    ]);
    expect(groupWikiFindings(findings, "page").map(group => [group.key, group.findings.length])).toEqual([[A, 4], [C, 1]]);
  });

  it("summarizes open kinds separately from stale findings", async () => {
    expect(summarizeWikiFindings(await sample())).toEqual({ conflicts: 3, uncertainties: 1, internal: 1, fixPending: 0, decided: 0, stale: 1, total: 5 });
  });
});
