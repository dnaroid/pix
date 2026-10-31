import { describe, expect, it, vi } from "vitest";
import { wikiEditableBlock } from "../lib/wiki-side-edit";
import { saveWikiSideEdit } from "./wiki-side-edit";

describe("Wiki side edit save", () => {
  const page = "a\nold\nc\n";
  const block = wikiEditableBlock(page, 2, 2)!;

  it("writes the edit with the read content as the compare-and-swap baseline", async () => {
    const write = vi.fn(async () => true);
    expect(await saveWikiSideEdit({ path: "wiki/a.md", block, text: "new" }, { read: async () => page, write, isCurrent: () => true })).toBe(true);
    expect(write).toHaveBeenCalledWith("wiki/a.md", "a\nnew\nc\n", page);
  });

  it("skips unchanged text and writes nothing after a project switch", async () => {
    const write = vi.fn(async () => true);
    expect(await saveWikiSideEdit({ path: "wiki/a.md", block, text: "old" }, { read: async () => page, write, isCurrent: () => true })).toBe(true);
    expect(await saveWikiSideEdit({ path: "wiki/a.md", block, text: "new" }, { read: async () => page, write, isCurrent: () => false })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("throws a localized error when the fragment changed since editing started", async () => {
    const write = vi.fn(async () => true);
    await expect(saveWikiSideEdit({ path: "wiki/a.md", block, text: "new" },
      { read: async () => "a\nchanged\nc\n", write, isCurrent: () => true, language: "ru" })).rejects.toThrow(/изменился/u);
    expect(write).not.toHaveBeenCalled();
  });
});
