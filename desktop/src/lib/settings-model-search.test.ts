import { describe, expect, it } from "vitest";
import type { ModelThinkingModel } from "./model-thinking";
import {
  searchSettingsModelOptions,
  searchSettingsModels,
  settingsModelLabel,
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
  it("offers trimmed wildcard and bare-model values only when custom entry is enabled", () => {
    const options = settingsModelSearchOptions(models);
    for (const pattern of ["anthropic/*", "glm-?", "my-model"]) {
      expect(searchSettingsModelOptions(options, ` ${pattern} `, true)[0]).toMatchObject({
        value: pattern,
        description: "Custom model or pattern",
      });
      expect(searchSettingsModelOptions(options, pattern).some((option) => option.value === pattern)).toBe(false);
    }
    expect(searchSettingsModelOptions([], "zai/*", true)[0]?.value).toBe("zai/*");
    expect(searchSettingsModelOptions(options, "   ", true)).toEqual(options);
  });

  it("does not duplicate exact catalog or configured patterns", () => {
    const options = [...settingsModelSearchOptions(models), { value: "zai/*", label: "zai/* · Configured" }];
    for (const value of ["openai-codex/gpt-5.6-sol", "zai/*"]) {
      const matches = searchSettingsModelOptions(options, value, true);
      expect(matches.filter((option) => option.value === value)).toHaveLength(1);
      expect(matches.find((option) => option.value === value)?.description).not.toBe("Custom model or pattern");
    }
  });

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
  it("labels models by display name without repeating the id", () => {
    expect(settingsModelLabel({ name: "GPT-5.6 Sol", modelId: "gpt-5.6-sol" })).toBe("GPT-5.6 Sol");
    expect(settingsModelSearchOptions(models)[0]).toMatchObject({ label: "GPT-5.6 Sol", description: "openai-codex/gpt-5.6-sol" });
    expect(searchSettingsModelOptions(settingsModelSearchOptions(models), "gpt-5.6-sol")[0]?.value).toBe("openai-codex/gpt-5.6-sol");
    expect(settingsModelLabel({ name: "glm-5.3", modelId: "glm-5.3" })).toBe("glm-5.3");
    expect(settingsModelLabel({ name: "GLM-5.3", modelId: "glm-5.3" })).toBe("GLM-5.3");
    expect(settingsModelLabel({ name: " ", modelId: "glm-5.3" })).toBe("glm-5.3");
  });
});
