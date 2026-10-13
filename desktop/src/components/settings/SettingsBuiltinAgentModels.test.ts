import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import SettingsBuiltinAgentModels from "./SettingsBuiltinAgentModels.svelte";
import componentSource from "./SettingsBuiltinAgentModels.svelte?raw";
import editorSource from "./ToolsSuiteSettingsEditor.svelte?raw";
import { parseSettingsSchema, settingsSourceIssues, updateSettingsSource, removeSettingsValue } from "../../lib/settings";
import schemaSource from "../../../../schemas/pi-tools-suite.json?raw";

describe("bundled agent model settings", () => {
  it("renders discovered explicit roles, retains unknown selections and exposes resets", () => {
    const html = render(SettingsBuiltinAgentModels, { props: {
      source: '{"builtinAgentModels":{"research":"unknown/model:high"}}', models: [], onChange: () => {},
    } }).body;
    expect(html).toContain("Model for bundled agent research");
    expect(html).toContain("unknown/model:high");
    expect(html).toContain("Reset research");
    expect(html).not.toContain("Model for bundled agent oracle");
    expect(html).toContain("Default / inherited");
  });

  it("uses the live non-auto model catalog and existing JSONC set/reset helpers", () => {
    expect(editorSource).toContain("<SettingsBuiltinAgentModels {source} {models} {onChange}");
    expect(componentSource).toContain('model.ref !== "pix:auto"');
    expect(componentSource).toContain("updateSettingsSource(source, path(agent.name), ref)");
    expect(componentSource).toContain("removeSettingsValue(source, path(agent.name))");
    const source = '// retained comment\n{"builtinAgentModels":{"verify":"old/verify"},"economy":true}';
    const changed = updateSettingsSource(source, ["builtinAgentModels", "research"], "new/model:high");
    const reset = removeSettingsValue(changed, ["builtinAgentModels", "research"]);
    expect(reset).toContain("retained comment");
    expect(reset).toContain("old/verify");
    expect(reset).not.toContain("new/model");
  });

  it("validates dynamic role values while permitting null to clear an inherited override", () => {
    const schema = parseSettingsSchema(schemaSource);
    expect(settingsSourceIssues('{"builtinAgentModels":{"research":"openrouter/vendor/model:high","verify":null}}', schema)).toEqual([]);
    expect(settingsSourceIssues('{"builtinAgentModels":{"research":false}}', schema)).not.toEqual([]);
    expect(settingsSourceIssues('{"builtinAgentModels":{"research":"invalid"}}', schema)).not.toEqual([]);
    expect(settingsSourceIssues('{"builtinAgentModels":{"research":"model with space"}}', schema)).not.toEqual([]);
    expect(settingsSourceIssues('{"builtinAgentModels":{"research":"provider/model:bogus"}}', schema)).not.toEqual([]);
  });
});
