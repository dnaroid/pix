import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { btwModelPickerConfig } from "./btw-model";
import { modelThinkingConfigState } from "../lib/model-thinking";

const options: SessionConfigOption[] = [
  { id: "model", name: "Model", type: "select", currentValue: "fixture/main", options: [
    { group: "fixture", name: "Fixture", options: [
      { value: "fixture/main", name: "Main", _meta: { "pix.thinkingLevels": ["off", "low", "high"] } },
      { value: "fixture/fast", name: "Fast", _meta: { "pix.thinkingLevels": ["low", "medium"] } },
      { value: "fixture/hidden", name: "Hidden" },
      { value: "pix:auto", name: "Auto" },
    ] },
  ] },
  { id: "thought_level", name: "Thinking", type: "select", currentValue: "high", options: [
    { value: "off", name: "off" }, { value: "low", name: "low" }, { value: "high", name: "high" },
  ] },
];

describe("BTW model picker configuration", () => {
  it("inherits the parent pair, keeps the complete catalogue for Manage and removes Auto", () => {
    const before = JSON.stringify(options);
    const state = modelThinkingConfigState(btwModelPickerConfig(options, null, null));
    expect(state.currentModel?.ref).toBe("fixture/main");
    expect(state.currentThinking).toBe("high");
    expect(state.models.map((model) => model.ref)).toEqual(["fixture/main", "fixture/fast", "fixture/hidden"]);
    expect(JSON.stringify(options)).toBe(before);
  });

  it("rebases current selection and clamps against the selected model's own metadata", () => {
    const selected = modelThinkingConfigState(btwModelPickerConfig(options, "fixture/fast", "high"));
    expect(selected.currentModel?.ref).toBe("fixture/fast");
    expect(selected.currentThinking).toBe("medium");
    expect(selected.currentThinkingLevels).toEqual(["low", "medium"]);
    const plain = modelThinkingConfigState(btwModelPickerConfig(options, "fixture/hidden", "high"));
    expect(plain.currentThinking).toBe("off");
    expect(plain.currentThinkingLevels).toEqual(["off"]);
    expect(modelThinkingConfigState(options).currentThinking).toBe("high");
  });

  it("does not silently substitute the parent for a removed explicit model", () => {
    const state = modelThinkingConfigState(btwModelPickerConfig(options, "fixture/removed", "high"));
    expect(state.currentModel).toBeUndefined();
    expect(state.models.every((model) => !model.current)).toBe(true);
  });
});
