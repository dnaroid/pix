import { describe, expect, it } from "vitest";
import { modelRefTone, thinkingLevelTone } from "./model-display";

describe("model/thinking display tones", () => {
  it("mirrors the shipped TUI model color rules", () => {
    expect(modelRefTone("zai/glm-5-turbo")).toBe("success");
    expect(modelRefTone("openai-codex/gpt-5.6-sol")).toBe("model-openai");
    expect(modelRefTone("antigravity/gemini-3")).toBe("warning");
    expect(modelRefTone("antigravity/antigravity-claude-opus-4")).toBe("error");
  });

  it("keeps provider fallback colors stable", () => {
    expect(modelRefTone("anthropic/claude-4")).toBe(modelRefTone("anthropic/claude-sonnet-4"));
    expect(modelRefTone("google/gemini-2.5-pro")).toBe(modelRefTone("google/gemini-3-pro"));
  });

  it("mirrors the TUI thinking palette and model-specific level subsets", () => {
    expect(thinkingLevelTone("off")).toBe("muted");
    expect(thinkingLevelTone("minimal")).toBe("success");
    expect(thinkingLevelTone("low")).toBe("model-openai");
    expect(thinkingLevelTone("medium")).toBe("warning");
    expect(thinkingLevelTone("high")).toBe("error");
    expect(thinkingLevelTone("xhigh")).toBe("thinking-xhigh");
    expect(thinkingLevelTone("max")).toBe("thinking-max");
    expect(thinkingLevelTone("medium", ["off", "medium", "high"])).toBe("warning");
  });
});
