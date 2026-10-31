import { describe, expect, it } from "vitest";
import { isKnowledgeDocumentPath, isNavigableKnowledgeCitation, knowledgeEvidenceText, matchKnowledgeCitation } from "./knowledge-citation";

const citation = { path: "wiki/rules.md", quote: "**Rule:** five retries.", startLine: 2, endLine: 2 };

describe("current-file citation matching", () => {
  it("recomputes moved line ranges while preserving literal Markdown evidence", () => {
    expect(matchKnowledgeCitation("# Rules\n\nNew context.\n\n**Rule:** five retries.\n", citation.path, citation)).toEqual({
      status: "matched", quote: citation.quote, range: { startLine: 5, endLine: 5 },
    });
  });

  it("normalizes line endings only and derives a complete multiline range", () => {
    const quote = "Первая строка.\r\nВторая строка.";
    expect(matchKnowledgeCitation("# Правила\r\n\r\nПервая строка.\r\nВторая строка.\r\n", citation.path, { ...citation, quote })).toEqual({
      status: "matched", quote: "Первая строка.\nВторая строка.", range: { startLine: 3, endLine: 4 },
    });
  });

  it("matches the logical body rather than a quotation repeated in saved report metadata", () => {
    const body = "---\ntitle: Rules\n---\n\n**Rule:** five retries.\n";
    const report = `<!-- pix:wiki-report ${JSON.stringify({ version: 1, checkedAt: "2026-10-30T12:00:00.000Z", result: { quote: citation.quote } })} -->\n`;
    const content = body.replace("---\n\n", `---\n\n${report}\n`);
    expect(matchKnowledgeCitation(content, citation.path, { ...citation, startLine: 6, endLine: 6 })).toEqual({
      status: "matched", quote: citation.quote, range: { startLine: 5, endLine: 5 },
    });
  });

  it("never treats report-only quotations as evidence from the current document", () => {
    const report = `<!-- pix:wiki-report ${JSON.stringify({ version: 1, checkedAt: "2026-10-30T12:00:00.000Z", result: { quote: citation.quote } })} -->\n`;
    expect(matchKnowledgeCitation(report + "Changed rule.\n", citation.path, citation)).toEqual({ status: "missing" });
  });

  it("uses explicit source fallback for a literal excerpt spanning a blanked report line", () => {
    const body = "---\ntitle: Rules\n---\nRule body.\n";
    const report = "<!-- pix:wiki-report {} -->\n";
    const content = body.replace("---\nRule", `---\n\n${report}Rule`);
    expect(matchKnowledgeCitation(content, citation.path, { ...citation, quote: "title: Rules\n---\n\n\nRule body." })).toEqual({ status: "source" });
  });

  it("never substitutes old line numbers for missing or ambiguous quotations", () => {
    expect(matchKnowledgeCitation("# Rules\n**Rule:** seven retries.", citation.path, citation)).toEqual({ status: "missing" });
    expect(matchKnowledgeCitation(`${citation.quote}\n${citation.quote}`, citation.path, citation)).toEqual({ status: "ambiguous" });
    expect(matchKnowledgeCitation(citation.quote, "wiki/another.md", citation)).toEqual({ status: "invalid" });
  });

  it.each(["/private/rules.md", "../rules.md", "wiki/../rules.md", "wiki\\rules.md", "wiki/./rules.md", "wiki//rules.md", "wiki/rules.md\n", "https://host/rules.md", "https:wiki/rule.md", "C:wiki/rule.md"])("rejects unsafe evidence path %s before reading", path => {
    expect(isKnowledgeDocumentPath(path)).toBe(false);
    expect(isNavigableKnowledgeCitation({ ...citation, path })).toBe(false);
  });

  it("rejects empty/oversized quotations and invalid locations", () => {
    for (const extra of [{ quote: " " }, { quote: "x".repeat(48_001) }, { startLine: 0 }, { endLine: 1 }, { startLine: 1.5 }]) {
      expect(isNavigableKnowledgeCitation({ ...citation, ...extra })).toBe(false);
    }
  });

  it("localizes precise, fallback and stale-evidence notices", () => {
    expect(knowledgeEvidenceText("exact", "ru")).toContain("точная цитата");
    expect(knowledgeEvidenceText("section", "ru")).toContain("раздел");
    expect(knowledgeEvidenceText("missing", "ru")).toContain("прежние номера строк не подсвечиваются");
    expect(knowledgeEvidenceText("ambiguous", "en")).toContain("ambiguous");
  });
});
