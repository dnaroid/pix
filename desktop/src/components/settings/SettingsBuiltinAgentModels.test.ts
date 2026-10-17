import { describe, expect, it } from "vitest";
import editorSource from "./ToolsSuiteSettingsEditor.svelte?raw";
import { parseSettingsSchema, settingsSourceIssues, updateSettingsSource, removeSettingsValue } from "../../lib/settings";
import schemaSource from "../../../../schemas/pi-tools-suite.json?raw";

describe("bundled agent model settings", () => {
  it("shows wizard-managed agent models as a read-only summary and keeps JSONC set/reset safe", () => {
    expect(editorSource).toContain('label="Sub-agent models"');
    expect(editorSource).toContain('text(["builtinAgentModels", agent])');
    expect(editorSource).toContain("<SettingsModelSummary");
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
