import { describe, expect, it } from "vitest";
import {
  parseSettingsSource,
  reconcileSavedSettingsDraft,
  removeSettingsValue,
  settingsDefaultValue,
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

describe("settings JSONC helpers", () => {
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

    expect(settingsDefaultValue("desktop", {
      type: "object",
      properties: {
        autocomplete: {
          type: "object",
          properties: { debounceMs: { type: "number" } },
        },
      },
    }, ["autocomplete", "debounceMs"])).toEqual({ exists: true, value: 350 });
    expect(settingsDefaultValue("desktop", schema, ["defaultModel", "modelRef"])).toEqual({ exists: true, value: "openai-codex/gpt-6-sol" });
    expect(settingsDefaultValue("desktop", schema, ["promptEnhancer", "modelRef"])).toEqual({ exists: true, value: "openai-codex/gpt-6-luna" });
    expect(settingsDefaultValue("desktop", schema, ["sessionTitle", "modelRef"])).toEqual({ exists: true, value: "openai-codex/gpt-6-luna" });
    expect(settingsDefaultValue("desktop", schema, ["desktop", "git", "reviewModelRef"])).toEqual({ exists: true, value: "openai-codex/gpt-6-luna:medium" });
    expect(settingsDefaultValue("desktop", schema, ["desktop", "git", "commitMessageModelRef"])).toEqual({ exists: true, value: "openai-codex/gpt-6-luna:minimal" });

    expect(settingsDefaultValue("pi-tools-suite", {
      type: "object",
      properties: { enabled: { type: "boolean" } },
    }, ["enabled"])).toEqual({ exists: true, value: true });
  });

  it("uses TUI runtime DCP omission defaults instead of the starter config template", () => {
    const dcpSchema: SettingsSchema = {
      type: "object",
      properties: {
        dcp: {
          type: "object",
          properties: {
            compress: {
              type: "object",
              properties: {
                nudgeFrequency: { type: "number" },
                summaryBuffer: { type: "boolean" },
                protectedTools: { type: "array", items: { type: "string" } },
                autoCandidates: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    minMessages: { type: "number" },
                    minTokens: { type: "number" },
                  },
                },
                messageMode: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    mediumTokens: { type: "number" },
                    highTokens: { type: "number" },
                    maxSuggestions: { type: "number" },
                  },
                },
                autoCompress: {
                  type: "object",
                  properties: {
                    summarizerFallbackModels: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
            modelOverrides: { type: "object" },
            debugLog: {
              type: "object",
              properties: {
                maxBytes: { type: "number" },
                maxBackups: { type: "number" },
              },
            },
          },
        },
      },
    };

    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "compress", "nudgeFrequency"])).toEqual({ exists: true, value: 2 });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "compress", "summaryBuffer"])).toEqual({ exists: true, value: true });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "compress", "protectedTools"])).toEqual({ exists: true, value: ["compress", "write", "edit"] });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "compress", "autoCandidates", "enabled"])).toEqual({ exists: true, value: true });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "compress", "autoCandidates", "minMessages"])).toEqual({ exists: true, value: 6 });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "compress", "autoCandidates", "minTokens"])).toEqual({ exists: true, value: 1500 });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "compress", "messageMode", "enabled"])).toEqual({ exists: true, value: true });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "compress", "messageMode", "mediumTokens"])).toEqual({ exists: true, value: 500 });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "compress", "messageMode", "highTokens"])).toEqual({ exists: true, value: 5000 });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "compress", "messageMode", "maxSuggestions"])).toEqual({ exists: true, value: 5 });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "compress", "autoCompress", "summarizerFallbackModels"])).toEqual({ exists: true, value: [] });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "modelOverrides"])).toEqual({ exists: true, value: {} });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "debugLog", "maxBytes"])).toEqual({ exists: true, value: 5 * 1024 * 1024 });
    expect(settingsDefaultValue("pi-tools-suite", dcpSchema, ["dcp", "debugLog", "maxBackups"])).toEqual({ exists: true, value: 3 });
  });

  it("keeps edits typed while an older save is in flight", () => {
    const latest: SettingsDraftDocument = {
      path: "/home/user/.config/pi/pix-desktop.jsonc",
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
