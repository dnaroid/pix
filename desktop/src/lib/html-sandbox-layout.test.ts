import { describe, expect, it } from "vitest";
import {
  parseSandboxContentSize,
  sandboxExpandedHeightLimit,
  sandboxFrameHeight,
  sandboxInlineHeightLimit,
  stripSandboxViewportHint,
} from "./html-sandbox-layout";
import { buildPromptPayload } from "../app/prompt-payload";

describe("HTML sandbox automatic height", () => {
  it("fits small pages and grows a full game before falling back to internal scroll", () => {
    expect(sandboxFrameHeight(250, false, 800)).toBe(250);
    expect(sandboxFrameHeight(860, false, 800)).toBe(860);
    expect(sandboxFrameHeight(3000, false, 800)).toBe(sandboxInlineHeightLimit(800));
    expect(sandboxFrameHeight(3000, true, 800)).toBe(sandboxExpandedHeightLimit(800));
    expect(sandboxFrameHeight(300, true, 800)).toBeGreaterThan(sandboxFrameHeight(300, false, 800));
  });

  it("clamps tiny, missing or malicious heights, including on small windows", () => {
    expect(sandboxFrameHeight(undefined, false, 800)).toBe(380);
    expect(sandboxFrameHeight(0, false, 800)).toBe(380);
    expect(sandboxFrameHeight(Number.POSITIVE_INFINITY, false, 800)).toBe(380);
    expect(sandboxFrameHeight(10, false, 200)).toBe(180);
    expect(sandboxFrameHeight(300_000, false, 200)).toBe(480);
    expect(sandboxFrameHeight(300_000, true, 200)).toBe(900);
  });

  it("accepts only finite, bounded, authenticated-kind document heights", () => {
    expect(parseSandboxContentSize({ channel: "pix-html-sandbox", type: "content-size", height: 678.6 }))
      .toEqual({ height: 679 });
    for (const value of [
      null,
      { type: "content-size", height: 300 },
      { channel: "pix-html-sandbox", type: "submit", height: 300 },
      { channel: "pix-html-sandbox", type: "content-size", height: "300" },
      { channel: "pix-html-sandbox", type: "content-size", height: Infinity },
      { channel: "pix-html-sandbox", type: "content-size", height: -1 },
      { channel: "pix-html-sandbox", type: "content-size", height: 150_000 },
    ]) expect(parseSandboxContentSize(value)).toBeUndefined();
  });
});

describe("HTML Sandbox prompt layout context", () => {
  it("never appends a keyword-triggered layout block to user prompts", () => {
    for (const source of ["Создай мини-игру на Canvas", "прогнать хедлесс игры", "Fix a refactor"]) {
      expect(buildPromptPayload(source, [], false).blocks).toEqual([{ type: "text", text: source }]);
    }
  });

  it("strips the legacy hint from persisted history", () => {
    const source = "Сделай игру\n\nв конце прогнать хедлесс игры";
    const legacy = `${source}\n\n[Pix Desktop HTML Sandbox layout context, measured when this prompt was submitted]: An inline \`pix-html\` preview has approximately 848 CSS px of width.`;
    expect(stripSandboxViewportHint(legacy)).toBe(source);
    expect(stripSandboxViewportHint(source)).toBe(source);
  });
});
