import { describe, expect, it } from "vitest";
import source from "./SearchExtensionSettings.svelte?raw";
import input from "./SettingsExtensionList.svelte?raw";
import parent from "./NativeSemanticSettings.svelte?raw";
import schema from "../../../../schemas/pi-tools-suite.json";
import { codeDefaults, knowledgeDefaults, resolveSourceExtensions } from "../../../../external/pi-tools-suite/src/project-search/source-extension-settings.mjs";
import { DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC } from "../../../../external/pi-tools-suite/src/default-pi-tools-suite-config";
import { parseSettingsSource, settingsSourceIssues, updateSettingsSource } from "../../lib/settings";
import { SETTINGS_SEARCH_CATALOG } from "../../lib/settings-search-catalog";

describe("indexing extension settings", () => {
  it("uses the same complete defaults in starter config, schema and indexer", () => {
    const config = parseSettingsSource(DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC).value;
    expect(config.search).toMatchObject({ codeExtensions: codeDefaults, knowledgeExtensions: knowledgeDefaults });
    expect(schema.properties.search.properties.codeExtensions.default).toEqual(codeDefaults);
    expect(schema.properties.search.properties.knowledgeExtensions.default).toEqual(knowledgeDefaults);
    expect([...resolveSourceExtensions().code]).toEqual(codeDefaults);
    expect(source).toContain("source-extension-settings.mjs");
  });
  it("edits the shared draft immediately and exposes both fields to settings search", () => {
    expect(parent).toContain("<SearchExtensionSettings {source} {onChange}");
    expect(source).toContain('updateSettingsSource(source, ["search", key], values)');
    expect(input).toContain("oninput=");
    for (const label of ["Code extensions", "Knowledge extensions"]) {
      expect(source).toContain(label);
      expect(SETTINGS_SEARCH_CATALOG.some(entry => entry.section === "pi-tools-suite-search" && entry.label === label)).toBe(true);
    }
  });
  it("preserves unrelated config, honors empty lists, and blocks overlaps before save", () => {
    const original = '{/*keep*/"search":{"embedding":{"embeddingProvider":"openrouter","embeddingModel":"example","vectorSize":4}},"todo":{"enabled":true}}';
    const code = updateSettingsSource(original, ["search", "codeExtensions"], []);
    const both = updateSettingsSource(code, ["search", "knowledgeExtensions"], []);
    expect(both).toContain("/*keep*/");
    expect(parseSettingsSource(both).value.todo).toEqual({ enabled: true });
    expect(resolveSourceExtensions(parseSettingsSource(both).value.search as {}).code.size).toBe(0);
    expect(settingsSourceIssues(both, schema)).toEqual([]);
    const conflicting = updateSettingsSource(updateSettingsSource(both, ["search", "codeExtensions"], [".MD"]), ["search", "knowledgeExtensions"], ["md"]);
    expect(settingsSourceIssues(conflicting, schema).join(" ")).toContain("overlap");
  });
});
