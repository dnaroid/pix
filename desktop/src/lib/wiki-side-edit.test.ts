import { describe, expect, it } from "vitest";
import { readKnowledgeReport, recordKnowledgeCheck, stripKnowledgeCheckStamp } from "../../../acp/src/knowledge/stamp";
import { applyWikiSideEdit, wikiEditableBlock } from "./wiki-side-edit";

async function hash(content: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("Wiki side inline edit", () => {
  it("replaces only the edited block and keeps the file's line endings", async () => {
    const page = "# Rules\r\n\r\nFighters have 6 points.\r\nSecond line.\r\n\r\nTail.\r\n";
    const block = wikiEditableBlock(page, 3, 4)!;
    expect(block.text).toBe("Fighters have 6 points.\nSecond line.");
    const next = await applyWikiSideEdit(page, block, "Fighters have 4 points.\nSecond line.");
    expect(next).toBe("# Rules\r\n\r\nFighters have 4 points.\r\nSecond line.\r\n\r\nTail.\r\n");
    expect(await applyWikiSideEdit(page, block, block.text)).toBe(page);
    expect(wikiEditableBlock(page, 0, 1)).toBeUndefined();
    expect(wikiEditableBlock(page, 3, 99)).toBeUndefined();
  });

  it("refuses to overwrite a block that changed after editing started", async () => {
    const block = wikiEditableBlock("a\nb\nc\n", 2, 2)!;
    expect(await applyWikiSideEdit("a\nB\nc\n", block, "x")).toBeUndefined();
    expect(await applyWikiSideEdit("a\n", block, "x")).toBeUndefined();
  });

  it("keeps the saved report with its old hash, so the finding reads as stale", async () => {
    const page = "# Rules\n\nFighters have 6 points.\n";
    const saved = await recordKnowledgeCheck(page, {
      status: "conflicts", path: "wiki/a.md", documentHash: await hash(page), modelRef: "test/judge", reportLanguage: "en", checkedSources: 1,
      conflicts: [{ draft: { path: "wiki/a.md", quote: "Fighters have 6 points.", startLine: 3, endLine: 3 },
        existing: { path: "wiki/b.md", quote: "Other.", startLine: 1, endLine: 1 }, explanation: "Differs." }],
      notices: [],
    }, "2026-10-30T00:00:00.000Z");
    // Body line numbers ignore the report line at the top of the raw file.
    const block = wikiEditableBlock(saved, 3, 3)!;
    expect(block.text).toBe("Fighters have 6 points.");
    const next = (await applyWikiSideEdit(saved, block, "Fighters have 4 points."))!;
    expect(stripKnowledgeCheckStamp(next)).toBe("# Rules\n\nFighters have 4 points.\n");
    const report = await readKnowledgeReport(next);
    expect(report?.current).toBe(false);
    expect(report?.result.conflicts).toHaveLength(1);
  });
});
