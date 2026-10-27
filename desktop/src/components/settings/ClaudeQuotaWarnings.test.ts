import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import ToolsSuiteSettingsEditor from "./ToolsSuiteSettingsEditor.svelte";
import schemaSource from "../../../../schemas/pi-tools-suite.json?raw";
import { parseSettingsSchema, parseSettingsSource, removeSettingsValue, settingsDefaultValue, settingsSourceIssues, updateSettingsSource } from "../../lib/settings";

const schema = parseSettingsSchema(schemaSource);
const path = ["claudeCodeProvider", "showRateLimitWarnings"];

describe("Claude quota warnings", () => {
  it("defaults off and supports validated save/reset", () => {
    expect(settingsDefaultValue("pi-tools-suite", schema, path).value).toBe(false);
    const source = updateSettingsSource("{}", path, true);
    expect(parseSettingsSource(source).value.claudeCodeProvider).toEqual({ showRateLimitWarnings: true });
    expect(settingsSourceIssues(source, schema)).toEqual([]);
    expect(settingsSourceIssues(updateSettingsSource(source, path, "true"), schema).length).toBeGreaterThan(0);
    expect(parseSettingsSource(removeSettingsValue(source, path)).value.claudeCodeProvider).toEqual({});
  });
  it("renders the switch in Claude settings", () => {
    const output = render(ToolsSuiteSettingsEditor, { props: { source: "{}", schema, models: [], section: "claude", onChange: () => {} } }).body;
    expect(output).toContain("Claude quota warnings");
    expect(output).toContain("Off by default");
    expect(output).toContain("actual limit errors remain visible");
  });
});
