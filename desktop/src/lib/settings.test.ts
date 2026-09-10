import { describe, expect, it } from "vitest";
import {
  parseSettingsSource,
  reconcileSavedSettingsDraft,
  removeSettingsValue,
  settingsDefaultValue,
  settingsSections,
  settingsSourceIssues,
  settingsValue,
  updateSettingsSource,
  type SettingsSchema,
  type SettingsDraftDocument,
} from "./settings";

const schema: SettingsSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean", description: "Enable feature." },
    nested: {
      type: "object",
      description: "Nested settings.",
      properties: {
        mode: {
          anyOf: [
            { type: "string", const: "off" },
            { type: "string", const: "on" },
          ],
        },
        retries: { type: "number", minimum: 0, maximum: 5 },
        names: { type: "array", items: { type: "string" } },
        map: { type: "object", patternProperties: { "^.*$": { type: "boolean" } } },
      },
    },
  },
};

describe("settings schema helpers", () => {
  it("builds dynamic form sections from nested schema properties", () => {
    const sections = settingsSections(schema);
    expect(sections.map((section) => section.title)).toEqual(["General", "Nested"]);
    expect(sections[0]?.fields.map((field) => [field.label, field.kind])).toEqual([
      ["Enabled", "boolean"],
    ]);
    expect(sections[1]?.fields.map((field) => [field.label, field.kind])).toEqual([
      ["Mode", "select"],
      ["Retries", "number"],
      ["Names", "string-list"],
      ["Map", "json"],
    ]);
  });

  it("uses path edits so comments and unrelated JSONC stay intact", () => {
    const original = `{
  "enabled": true,
  // keep this unrelated comment
  "nested": { "mode": "off" }
}\n`;
    const updated = updateSettingsSource(original, ["nested", "mode"], "on");
    expect(updated).toContain("// keep this unrelated comment");
    expect(updated).toContain('"enabled": true');
    expect(settingsValue(parseSettingsSource(updated).value, ["nested", "mode"])).toBe("on");

    const removed = removeSettingsValue(updated, ["enabled"]);
    expect(settingsValue(parseSettingsSource(removed).value, ["enabled"])).toBeUndefined();
  });

  it("validates raw JSONC against supported schema constraints", () => {
    expect(settingsSourceIssues('{ "nested": { "retries": 3 } }', schema)).toEqual([]);
    expect(settingsSourceIssues('{ "nested": { "retries": 9 } }', schema)[0]).toContain("<= 5");
    expect(settingsSourceIssues("[]", schema)[0]).toContain("root");
    expect(settingsSourceIssues("{ nope", schema)[0]).toContain("JSONC parse error");
  });

  it("resolves unset values from schema defaults, shipped defaults, then stable omission defaults", () => {
    expect(settingsDefaultValue("pi-tools-suite", {
      type: "object",
      properties: { enabled: { type: "boolean", default: false } },
    }, ["enabled"])).toEqual({ exists: true, value: false });

    expect(settingsDefaultValue("pix", {
      type: "object",
      properties: {
        autocomplete: {
          type: "object",
          properties: { debounceMs: { type: "number" } },
        },
      },
    }, ["autocomplete", "debounceMs"])).toEqual({ exists: true, value: 350 });

    expect(settingsDefaultValue("pi-tools-suite", {
      type: "object",
      properties: { enabled: { type: "boolean" } },
    }, ["enabled"])).toEqual({ exists: true, value: true });
  });

  it("keeps edits typed while an older save is in flight", () => {
    const latest: SettingsDraftDocument = {
      path: "/home/user/.config/pi/pix.jsonc",
      content: '{ "enabled": true }\n',
      exists: true,
      schema: "{}",
      schemaObject: {},
      source: '{ "enabled": false, "newer": true }\n',
      savedSource: '{ "enabled": true }\n',
    };
    const saved = {
      path: latest.path,
      content: '{ "enabled": false }\n',
      exists: true,
      schema: latest.schema,
    };

    const reconciled = reconcileSavedSettingsDraft(
      latest,
      '{ "enabled": false }\n',
      saved,
    );
    expect(reconciled.source).toBe(latest.source);
    expect(reconciled.savedSource).toBe(saved.content);

    const unchanged = reconcileSavedSettingsDraft(
      { ...latest, source: '{ "enabled": false }\n' },
      '{ "enabled": false }\n',
      saved,
    );
    expect(unchanged.source).toBe(saved.content);
    expect(unchanged.savedSource).toBe(saved.content);
  });
});
