import { describe, expect, it } from "vitest";
import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import { recordKnowledgeCheck } from "../../../acp/src/knowledge/stamp";
import { wikiCitationContext, wikiCitationSourceLines } from "./wiki-citation-context";

const citation = (quote: string, path = "wiki/a.md"): KnowledgeCitation => ({ path, quote, startLine: 99, endLine: 99 });
async function hash(content: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
const body = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);

describe("Wiki citation context", () => {
  it("locates the quotation in the current file, not by saved line numbers, with ±8 lines", () => {
    const context = wikiCitationContext(body.join("\r\n"), citation("line 15\nline 16"));
    expect(context.status).toBe("matched");
    if (context.status !== "matched") return;
    // One paragraph: the whole block is the quote, no separate context blocks.
    expect(context).toMatchObject({ startLine: 1, endLine: 30, before: "", after: "", truncated: false });
    const blocks = Array.from({ length: 30 }, (_, index) => `para ${index + 1}`).join("\n\n");
    const split = wikiCitationContext(blocks, citation("para 15"));
    expect(split).toMatchObject({ status: "matched", quote: "para 15", startLine: 29, endLine: 29 });
    if (split.status !== "matched") return;
    expect(split.before.startsWith("para 11")).toBe(true);
    expect(split.after.endsWith("para 19")).toBe(true);
  });

  it("expands the quote to the whole table and never splits fenced code", () => {
    const content = ["Intro.", "", "| A | B |", "| - | - |", "| 1 | 2 |", "| 3 | 4 |", "", "```", "x", "", "y", "```", "", "Tail."].join("\n");
    const table = wikiCitationContext(content, citation("| 3 | 4 |"));
    expect(table).toMatchObject({ status: "matched", quote: "| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |", before: "Intro.", startLine: 3, endLine: 6 });
    if (table.status === "matched") expect(table.tableRows).toEqual({ first: 2, last: 2 });
    const header = wikiCitationContext(content, citation("| A | B |"));
    expect(header.status === "matched" && header.tableRows).toEqual({ first: 0, last: 0 });
    const whole = wikiCitationContext(content, citation("| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |"));
    expect(whole.status === "matched" && whole.tableRows).toBeUndefined();
    const code = wikiCitationContext(content, citation("y"));
    expect(code).toMatchObject({ status: "matched", quote: "```\nx\n\ny\n```", startLine: 8, endLine: 12 });
  });

  it("returns the nearest heading above the quotation and ignores headings inside fences", () => {
    const content = ["# Top", "## Combat", "~~~md", "# Not a heading", "~~~", "Cover is circular."].join("\n");
    const context = wikiCitationContext(content, citation("Cover is circular."));
    expect(context).toMatchObject({ status: "matched", heading: "Combat" });
  });

  it("reports a changed, repeated or invalid quotation without any context lines", () => {
    expect(wikiCitationContext(body.join("\n"), citation("gone"))).toEqual({ status: "missing" });
    expect(wikiCitationContext("same\nsame", citation("same"))).toEqual({ status: "ambiguous" });
    expect(wikiCitationContext("x", citation("x", "../outside.md"))).toEqual({ status: "invalid" });
  });

  it("bounds a huge quotation", () => {
    const context = wikiCitationContext(body.join("\n"), citation(body.slice(0, 20).join("\n")), 8, 5);
    expect(context).toMatchObject({ status: "matched", truncated: true });
    if (context.status === "matched") expect(context.endLine - context.startLine + 1).toBe(5);
  });

  it("maps a unique quotation to raw-file lines even when saved report metadata repeats it", async () => {
    const page = "# Rules\r\n\r\nFighters have 6 points.\r\nSecond line.\r\n";
    const quote = "Fighters have 6 points.\nSecond line.";
    expect(wikiCitationSourceLines(page, quote)).toEqual({ startLine: 3, endLine: 4 });
    const saved = await recordKnowledgeCheck(page, {
      status: "conflicts", path: "wiki/a.md", documentHash: await hash(page), modelRef: "test/judge", reportLanguage: "en", checkedSources: 1,
      conflicts: [{ draft: { path: "wiki/a.md", quote, startLine: 3, endLine: 4 }, existing: { path: "wiki/b.md", quote: "Other.", startLine: 1, endLine: 1 }, explanation: "Differs." }],
      notices: [],
    }, "2026-10-30T00:00:00.000Z");
    expect(saved).toContain("Fighters have 6 points.");
    // The report occupies the first raw line; blame needs raw-file numbers.
    expect(saved.split("\n")[0]).toMatch(/^<!-- pix:wiki-report /u);
    expect(wikiCitationSourceLines(saved, quote)).toEqual({ startLine: 4, endLine: 5 });
    expect(wikiCitationSourceLines("x\nx\n", "x")).toBeUndefined();
    expect(wikiCitationSourceLines(page, "absent")).toBeUndefined();
    expect(wikiCitationSourceLines(page, "")).toBeUndefined();
  });
});
