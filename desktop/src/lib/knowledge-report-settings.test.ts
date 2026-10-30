import { describe, expect, it } from "vitest";
import desktopSchemaSource from "../../../schemas/pix-desktop.json?raw";
import suiteSchemaSource from "../../../schemas/pi-tools-suite.json?raw";
import { DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC } from "../../../external/pi-tools-suite/src/default-pi-tools-suite-config.js";
import { DEFAULT_DESKTOP_CONFIG_JSONC } from "./default-desktop-config";
import {
  parseSettingsSource,
  removeSettingsValue,
  settingsDefaultValue,
  settingsSourceIssues,
  settingsValue,
  updateSettingsSource,
  type SettingsSchema,
} from "./settings";

const desktopSchema = JSON.parse(desktopSchemaSource) as SettingsSchema;
const suiteSchema = JSON.parse(suiteSchemaSource) as SettingsSchema;
const languagePath = ["knowledgeCheck", "reportLanguage"];
const configured = (reportLanguage: unknown): string => JSON.stringify({ knowledgeCheck: { reportLanguage } });

describe("Wiki report-language settings", () => {
  it("validates supported languages and allows inheritance only in Desktop", () => {
    for (const value of ["en", "ru"]) {
      expect(settingsSourceIssues(configured(value), suiteSchema)).toEqual([]);
      expect(settingsSourceIssues(configured(value), desktopSchema)).toEqual([]);
    }
    expect(settingsSourceIssues(configured(""), desktopSchema)).toEqual([]);
    expect(settingsSourceIssues(configured(""), suiteSchema)).not.toEqual([]);
    for (const value of ["fr", "ru-RU", 7, null, {}, ["ru"]]) {
      expect(settingsSourceIssues(configured(value), suiteSchema)).not.toEqual([]);
      expect(settingsSourceIssues(configured(value), desktopSchema)).not.toEqual([]);
    }
    expect(settingsSourceIssues("{}", suiteSchema)).toEqual([]);
    expect(settingsSourceIssues("{}", desktopSchema)).toEqual([]);
  });

  it("keeps the suite default English and the generated Desktop config inheriting it", () => {
    expect(settingsDefaultValue("pi-tools-suite", suiteSchema, languagePath)).toEqual({ exists: true, value: "en" });
    expect(settingsDefaultValue("desktop", desktopSchema, languagePath)).toEqual({ exists: true, value: "" });
    expect(settingsValue(parseSettingsSource(DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC).value, languagePath)).toBe("en");
    expect(settingsValue(parseSettingsSource(DEFAULT_DESKTOP_CONFIG_JSONC).value, languagePath)).toBe("");
    expect(settingsSourceIssues(configured(settingsValue(parseSettingsSource(DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC).value, languagePath)), suiteSchema)).toEqual([]);
    expect(settingsSourceIssues(configured(settingsValue(parseSettingsSource(DEFAULT_DESKTOP_CONFIG_JSONC).value, languagePath)), desktopSchema)).toEqual([]);
  });

  it("saves and resets the language without changing neighboring settings or JSONC comments", () => {
    const original = `{
  // Preserve the selected model and unrelated report preferences.
  "search": { "ragModelRef": "provider/judge" },
  "knowledgeCheck": { "otherPreference": true }
}`;
    const updated = updateSettingsSource(original, languagePath, "ru");
    expect(settingsValue(parseSettingsSource(updated).value, languagePath)).toBe("ru");
    expect(settingsSourceIssues(updated, desktopSchema)).toEqual([]);
    const reset = removeSettingsValue(updated, languagePath);
    expect(settingsValue(parseSettingsSource(reset).value, languagePath)).toBeUndefined();
    expect(settingsValue(parseSettingsSource(reset).value, ["knowledgeCheck", "otherPreference"])).toBe(true);
    expect(settingsValue(parseSettingsSource(reset).value, ["search", "ragModelRef"])).toBe("provider/judge");
    expect(reset).toContain("// Preserve the selected model and unrelated report preferences.");
  });
});

describe("independent contradiction judge settings", () => {
  it("validates model references and every explicit reasoning budget in both profiles", () => {
    for (const schema of [suiteSchema, desktopSchema]) {
      for (const thinking of ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
        expect(settingsSourceIssues(JSON.stringify({ knowledgeCheck: { modelRef: "provider/vendor/model", thinking } }), schema)).toEqual([]);
      }
      for (const modelRef of ["not-a-ref", "/model", "provider/", "provider/model:high", "provider/with space", 123, null]) {
        expect(settingsSourceIssues(JSON.stringify({ knowledgeCheck: { modelRef } }), schema)).not.toEqual([]);
      }
      for (const thinking of ["ultra", 123, null]) {
        expect(settingsSourceIssues(JSON.stringify({ knowledgeCheck: { thinking } }), schema)).not.toEqual([]);
      }
    }
  });
  it("defaults to an unselected Suite judge and field-wise inheritance in Desktop", () => {
    for (const [kind, schema, source] of [
      ["pi-tools-suite", suiteSchema, DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC],
      ["desktop", desktopSchema, DEFAULT_DESKTOP_CONFIG_JSONC],
    ] as const) {
      expect(settingsDefaultValue(kind, schema, ["knowledgeCheck", "modelRef"]).value).toBe("");
      expect(settingsDefaultValue(kind, schema, ["knowledgeCheck", "thinking"]).value).toBe(kind === "desktop" ? "" : "low");
      expect(settingsValue(parseSettingsSource(source).value, ["knowledgeCheck", "modelRef"])).toBe("");
      expect(settingsValue(parseSettingsSource(source).value, ["knowledgeCheck", "thinking"])).toBe(kind === "desktop" ? "" : "low");
    }
  });
  it("changes and resets judge fields without touching RAG, session settings or report language", () => {
    const original = '{ // keep this\n"search":{"ragModelRef":"search/model","ragThinking":"medium"},"defaultModel":{"modelRef":"session/model"},"knowledgeCheck":{"reportLanguage":"ru"}}';
    let source = updateSettingsSource(original, ["knowledgeCheck", "modelRef"], "judge/model");
    source = updateSettingsSource(source, ["knowledgeCheck", "thinking"], "high");
    expect(settingsSourceIssues(source, desktopSchema)).toEqual([]);
    expect(parseSettingsSource(source).value.knowledgeCheck).toEqual({ modelRef: "judge/model", thinking: "high", reportLanguage: "ru" });
    source = removeSettingsValue(source, ["knowledgeCheck", "modelRef"]);
    source = removeSettingsValue(source, ["knowledgeCheck", "thinking"]);
    expect(parseSettingsSource(source).value).toEqual(parseSettingsSource(original).value);
    expect(source).toContain("// keep this");
  });
});
