import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { clampThinkingLevel, modelThinkingConfigState } from "./model-thinking";

const configOptions: SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "openai-codex/gpt-5.6-sol",
    options: [
      {
        group: "openai-codex",
        name: "openai-codex",
        options: [
          {
            value: "openai-codex/gpt-5.6-luna",
            name: "GPT-5.6 Luna",
            _meta: { "pix.thinkingLevels": ["off", "minimal", "low", "medium"] },
          },
          {
            value: "openai-codex/gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            _meta: { "pix.thinkingLevels": ["off", "minimal", "low", "medium", "high", "xhigh"] },
          },
        ],
      },
    ],
  },
  {
    id: "thought_level",
    name: "Thought level",
    type: "select",
    currentValue: "high",
    options: ["off", "minimal", "low", "medium", "high", "xhigh"].map((value) => ({ value, name: value })),
  },
];

describe("model + thinking config", () => {
  it("extracts per-model thinking levels and keeps the current model first", () => {
    const state = modelThinkingConfigState(configOptions);
    expect(state.currentModel?.ref).toBe("openai-codex/gpt-5.6-sol");
    expect(state.currentThinking).toBe("high");
    expect(state.models.map((model) => model.ref)).toEqual([
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-luna",
    ]);
    expect(state.models[1]?.thinkingLevels).toEqual(["off", "minimal", "low", "medium"]);
  });

  it("clamps staged thinking like the pi runtime when a selected model supports fewer levels", () => {
    expect(clampThinkingLevel("high", ["off", "minimal", "low", "medium"])).toBe("medium");
    expect(clampThinkingLevel("xhigh", ["off", "minimal", "medium", "high", "max"])).toBe("max");
    expect(clampThinkingLevel("medium", ["off"])).toBe("off");
  });
});
