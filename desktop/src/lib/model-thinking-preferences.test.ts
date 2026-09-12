import { describe, expect, it } from "vitest";
import {
  modelThinkingPreferencesFromPixConfig,
  updateModelThinkingPreferenceInPixConfig,
} from "./model-thinking-preferences";

describe("model thinking preferences", () => {
  it("reads only valid model thinking levels", () => {
    expect(modelThinkingPreferencesFromPixConfig(`{
      "thinkingByModel": {
        "openai-codex/gpt-5.6-sol": "high",
        "zai/glm-5-turbo": "MAX",
        "bad/model": "turbo"
      }
    }`)).toEqual({
      "openai-codex/gpt-5.6-sol": "high",
      "zai/glm-5-turbo": "max",
    });
  });

  it("updates one model without replacing sibling preferences", () => {
    const source = `{
      // keep
      "thinkingByModel": { "openai/a": "low", "zai/b": "max" }
    }`;
    const updated = updateModelThinkingPreferenceInPixConfig(source, "openai/a:high", "medium");
    expect(updated).toContain("// keep");
    expect(modelThinkingPreferencesFromPixConfig(updated)).toEqual({
      "openai/a": "medium",
      "zai/b": "max",
    });
  });
});
