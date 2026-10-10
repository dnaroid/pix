import { describe, expect, it } from "vitest";
import {
  parseSandboxContentSize,
  sandboxExpandedHeightLimit,
  sandboxFrameHeight,
  sandboxInlineHeightLimit,
  sandboxViewportHint,
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

describe("agent-facing HTML Sandbox viewport context", () => {
  const viewport = { width: 642.8, maxHeight: 1080 };

  it("adds the measured inline viewport only for prototyping/game requests", () => {
    const hint = sandboxViewportHint("Сделай интерактивную игру на Canvas", viewport);
    expect(hint).toContain("643 CSS px");
    expect(hint).toContain("1080 CSS px");
    expect(hint).toContain("window resize");
    expect(sandboxViewportHint("Fix the TypeScript compiler error", viewport)).toBeUndefined();
    for (const prompt of ["Animate a cube in chat", "Three.js scene", "Phaser demo", "Анимация в чате"]) {
      expect(sandboxViewportHint(prompt, viewport)).toContain("643 CSS px");
    }
    expect(sandboxViewportHint("Create pix-html prototype", { width: NaN, maxHeight: 1080 })).toBeUndefined();
  });

  it("adds a separate, ephemeral agent content block, keeping the user's visible text unchanged", () => {
    const source = "Создай мини-игру на Canvas";
    const result = buildPromptPayload(source, [], false, viewport);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]).toEqual({ type: "text", text: source });
    expect(result.blocks[1]).toEqual({
      type: "text",
      text: expect.stringContaining("643 CSS px"),
    });
    expect(buildPromptPayload("Fix a refactor", [], false, viewport).blocks).toEqual([
      { type: "text", text: "Fix a refactor" },
    ]);
  });
});
