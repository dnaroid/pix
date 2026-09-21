import { describe, expect, it } from "vitest";
import type { ModelThinkingModel } from "./model-thinking";
import {
  searchSettingsModelOptions,
  searchSettingsModels,
  settingsModelSearchOptions,
} from "./settings-model-search";

const models: ModelThinkingModel[] = [
  {
    ref: "openai-codex/gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
    thinkingLevels: ["off", "high"],
    current: true,
    tone: "model-openai",
  },
  {
    ref: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    thinkingLevels: ["off"],
    current: false,
    tone: "warning",
  },
  {
    ref: "zai/glm-5.3",
    name: "GLM 5.3",
    provider: "zai",
    modelId: "glm-5.3",
    thinkingLevels: ["off"],
    current: false,
    tone: "success",
  },
];

describe("settings model fuzzy search", () => {
  it("matches model ref, id, display name, and provider", () => {
    expect(searchSettingsModels(models, "g56")[0]?.ref).toBe("openai-codex/gpt-5.6-sol");
    expect(searchSettingsModels(models, "sonnet")[0]?.ref).toBe("anthropic/claude-sonnet-4-6");
    expect(searchSettingsModels(models, "zai")[0]?.ref).toBe("zai/glm-5.3");
  });

  it("preserves model order with an empty query", () => {
    expect(searchSettingsModels(models, "").map((model) => model.ref)).toEqual(models.map((model) => model.ref));
  });

  it("searches custom selector options through values and aliases", () => {
    const options = settingsModelSearchOptions(models).map((option) => (
      option.value === "openai-codex/gpt-5.6-sol"
        ? {
            ...option,
            value: `${option.value}:high`,
            label: "GPT-5.6 Sol · High",
            aliases: [...(option.aliases ?? []), "high"],
          }
        : option
    ));
    expect(searchSettingsModelOptions(options, "gpt high")[0]?.value).toBe("openai-codex/gpt-5.6-sol:high");
  });
});
