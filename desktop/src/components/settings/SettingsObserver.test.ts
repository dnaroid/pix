import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import SettingsObserver from "./SettingsObserver.svelte";
import schemaSource from "../../../../schemas/pix-desktop.json?raw";
import { DEFAULT_HEADS_UP_CONFIG, HEADS_UP_CONFIG_LIMITS } from "../../../../src/bundled-extensions/heads-up/config";
import { parseSettingsSchema, parseSettingsSource, removeSettingsValue, settingsDefaultValue, settingsSourceIssues, updateSettingsSource } from "../../lib/settings";

const PixDesktopConfigSchema = parseSettingsSchema(schemaSource);

describe("Desktop Observer settings", () => {
  it("uses the same defaults/bounds as the runtime with an independent saved section", () => {
    const schema = PixDesktopConfigSchema;
    for (const [key, value] of Object.entries(DEFAULT_HEADS_UP_CONFIG)) {
      expect(settingsDefaultValue("desktop", schema, ["headsUp", key]).value).toBe(value);
      const field = schema.properties?.headsUp?.properties?.[key];
      expect([field?.minimum, field?.maximum]).toEqual(HEADS_UP_CONFIG_LIMITS[key as keyof typeof DEFAULT_HEADS_UP_CONFIG]);
    }
    let source = '{\n // keep this\n "defaultModel": {"modelRef":"main/model"}\n}';
    source = updateSettingsSource(source, ["headsUp", "model"], "observer/model");
    expect(parseSettingsSource(source).value.defaultModel).toEqual({ modelRef: "main/model" });
    expect(source).toContain("// keep this");
    source = removeSettingsValue(source, ["headsUp", "model"]);
    expect(parseSettingsSource(source).value.headsUp).toEqual({});
    expect(settingsSourceIssues('{"headsUp":{"minTurns":0}}', schema).length).toBeGreaterThan(0);
    expect(settingsSourceIssues('{"headsUp":{"model":"not-a-provider-ref"}}', schema).length).toBeGreaterThan(0);
    expect(settingsSourceIssues('{"headsUp":{"model":"provider/model"}}', schema)).toEqual([]);
  });
  it("renders labelled model/switch/numbers, seconds and mounted advanced fields for search", () => {
    const output = render(SettingsObserver, { props: { source: "{}", schema: PixDesktopConfigSchema, models: [], onChange: () => {} } }).body;
    expect(output).toContain('aria-label="Observer model"');
    expect(output).toContain('aria-label="Enable Observer in new Desktop sessions"');
    expect(output).toContain("Default · 60 seconds");
    expect(output).toContain('aria-label="Observer request timeout in seconds"');
    expect(output).toContain("<details");
    expect(output).toContain("TUI settings are independent");
  });
});
