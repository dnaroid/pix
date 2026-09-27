import { describe, expect, it } from "vitest";
import { modelProviderBrand, modelRefTone, thinkingLevelTone } from "./model-display";

describe("model/thinking display tones", () => {
  it("uses distinct desktop colors for known AI providers", () => {
    expect(modelRefTone("anthropic/claude-4")).toBe("model-anthropic");
    expect(modelRefTone("openai-codex/gpt-5.6-sol")).toBe("model-openai");
    expect(modelRefTone("zai/glm-5-turbo")).toBe("model-zai");
  });

  it("normalizes provider aliases used by desktop model pickers", () => {
    expect(modelProviderBrand("anthropic")).toBe("anthropic");
    expect(modelProviderBrand("pi-claude-code-provider")).toBe("anthropic");
    expect(modelProviderBrand("pi-claude-code-provider/opus")).toBe("anthropic");
    expect(modelRefTone("pi-claude-code-provider/opus")).toBe("model-anthropic");
    expect(modelProviderBrand("antigravity/antigravity-gemini-3.8-flash")).toBe("google");
    expect(modelProviderBrand("google/gemini-3-pro")).toBe("google");
    expect(modelProviderBrand("openai-codex/gpt-5.6-sol")).toBe("openai");
    expect(modelProviderBrand("zai/glm-5-turbo")).toBe("zai");
    expect(modelProviderBrand("other/model")).toBeUndefined();
  });

  it("keeps the remaining shipped TUI model color rules", () => {
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
    expect(thinkingLevelTone("low")).toBe("thinking-low");
    expect(thinkingLevelTone("medium")).toBe("warning");
    expect(thinkingLevelTone("high")).toBe("error");
    expect(thinkingLevelTone("xhigh")).toBe("thinking-xhigh");
    expect(thinkingLevelTone("max")).toBe("thinking-max");
    expect(thinkingLevelTone("medium", ["off", "medium", "high"])).toBe("warning");
  });
});
