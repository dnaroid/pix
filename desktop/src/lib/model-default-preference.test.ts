import { describe, expect, it } from "vitest";
import {
  modelDefaultSelectionFromPixConfig,
  updateModelDefaultSelectionInPixConfig,
} from "./model-default-preference";
import { parseSettingsSource } from "./settings";

describe("model default preference", () => {
  it("reads Auto as the effective default when routing.default is enabled", () => {
    expect(modelDefaultSelectionFromPixConfig(`{
      "defaultModel": { "modelRef": "openai/a", "thinking": "high" },
      "modelRouting": { "enabled": true, "default": true }
    }`)).toEqual({ kind: "auto" });
  });

  it("reads a concrete model and thinking pair", () => {
    expect(modelDefaultSelectionFromPixConfig(`{
      "defaultModel": { "modelRef": "openai/a", "thinking": "high" }
    }`)).toEqual({ kind: "model", modelRef: "openai/a", thinking: "high" });
  });

  it("sets Auto default without discarding the concrete fallback default", () => {
    const source = `{
      "defaultModel": { "modelRef": "openai/a", "fallbackModels": ["openai/b"], "thinking": "high" },
      "modelRouting": { "enabled": false, "default": false, "defaultTier": "standard" }
    }`;
    const updated = updateModelDefaultSelectionInPixConfig(source, { kind: "auto" });
    const root = parseSettingsSource(updated).value;
    expect(root.defaultModel).toEqual({
      modelRef: "openai/a",
      fallbackModels: ["openai/b"],
      thinking: "high",
    });
    expect(root.modelRouting).toMatchObject({ enabled: true, default: true, defaultTier: "standard" });
  });

  it("sets a concrete pair and disables Auto default while preserving fallbacks", () => {
    const source = `{
      "defaultModel": { "modelRef": "openai/a", "fallbackModels": ["openai/b"], "thinking": "low" },
      "modelRouting": { "enabled": true, "default": true }
    }`;
    const updated = updateModelDefaultSelectionInPixConfig(source, {
      kind: "model",
      modelRef: "openai/c",
      thinking: "xhigh",
    });
    const root = parseSettingsSource(updated).value;
    expect(root.defaultModel).toEqual({
      modelRef: "openai/c",
      fallbackModels: ["openai/b"],
      thinking: "xhigh",
    });
    expect(root.modelRouting).toMatchObject({ enabled: true, default: false });
  });
});
