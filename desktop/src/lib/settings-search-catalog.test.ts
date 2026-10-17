import { describe, expect, it } from "vitest";
import desktopEditorSource from "../components/settings/DesktopSettingsEditor.svelte?raw";
import toolsEditorSource from "../components/settings/ToolsSuiteSettingsEditor.svelte?raw";
import searchPreferencesSource from "../components/settings/SettingsSearchPreferences.svelte?raw";
import { SETTINGS_SEARCH_CATALOG, settingsFieldId } from "./settings-search-catalog";

describe("authored settings search catalogue", () => {
  it("makes tray mode searchable and discloses its global restart requirement", () => {
    const entry = SETTINGS_SEARCH_CATALOG.find(entry => entry.id === "show-menu-bar-icon");
    expect(entry?.section).toBe("desktop-general");
    expect(entry?.synonyms).toContain("tray");
    expect(desktopEditorSource).toContain('label="Show menu bar icon"');
    expect(desktopEditorSource).toContain("keeping the Dock icon and application menus");
    expect(entry?.description).toContain("Keeps the Dock icon and application menus");
    expect(desktopEditorSource).toContain('bool(["desktop", "trayOnly"])');
    expect(desktopEditorSource).toContain('onReset={() => reset(["desktop", "trayOnly"])}');
    expect(desktopEditorSource).toContain("Applies to all windows after restarting Pix");
  });

  it("keeps semantic provider configuration native and ACP-independent", () => {
    expect(searchPreferencesSource).toContain("managed under Tools Suite → Search");
    expect(searchPreferencesSource).toContain("every source and project");
    expect(searchPreferencesSource).not.toContain("client");
  });

  it("removes independent semantic toggles but discloses separate RAG transfer", () => {
    expect(searchPreferencesSource).toContain("RAG is separate");
    expect(searchPreferencesSource).not.toContain("tasksSemanticEnabled");
    expect(searchPreferencesSource).not.toContain("sessionTitlesEnabled");
    expect(searchPreferencesSource).toContain("bounded retrieved source excerpts and the question are sent to the selected RAG model provider");
    expect(desktopEditorSource).toContain('label="Feature models"');
    expect(desktopEditorSource).toContain('label="RAG thinking effort"');
    expect(searchPreferencesSource).not.toContain("SEARCH_FILTER_MODEL");
    expect(searchPreferencesSource).not.toContain("messageFilterEnabled");
    expect(SETTINGS_SEARCH_CATALOG.find(entry => entry.id === "message-noise-filter")).toBeUndefined();
  });

  it("contains stable, unique field identities with authored labels and metadata", () => {
    const identities = SETTINGS_SEARCH_CATALOG.map(({ section, id }) => `${section}/${id}`);
    expect(new Set(identities).size).toBe(identities.length);
    for (const entry of SETTINGS_SEARCH_CATALOG) {
      expect(entry.section).toMatch(/^(desktop|pi-tools-suite)-[a-z-]+$/u);
      expect(entry.id).toBe(settingsFieldId(entry.label));
      expect(entry.label.trim()).not.toBe("");
      expect(Array.isArray(entry.synonyms)).toBe(true);
    }
    expect(SETTINGS_SEARCH_CATALOG.some((entry) => entry.section === "desktop-assistant" && entry.label === "Recent messages")).toBe(true);
    expect(SETTINGS_SEARCH_CATALOG.find(entry => entry.id === "embedding-model")?.section).toBe("pi-tools-suite-search");
    expect(SETTINGS_SEARCH_CATALOG.some((entry) => entry.section === "pi-tools-suite-dcp" && entry.label === "Automatic compression")).toBe(true);
  });

  it("covers every literal field label authored by both settings editors", () => {
    const catalogLabels = new Set(SETTINGS_SEARCH_CATALOG.map((entry) => entry.label));
    for (const [name, source] of [["DesktopSettingsEditor.svelte", desktopEditorSource], ["ToolsSuiteSettingsEditor.svelte", toolsEditorSource]] as const) {
      for (const [, label] of source.matchAll(/\blabel="([^"]+)"/gu)) expect(catalogLabels, `${name}: ${label}`).toContain(label);
    }
  });

  it("does not contain runtime config values or a writable credential value", () => {
    const serialized = JSON.stringify(SETTINGS_SEARCH_CATALOG).toLowerCase();
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("apikey");
    expect(serialized).not.toContain("current value");
    expect(serialized).not.toContain("secret value");
  });

  it("uses exact section and field ids for deep-link matching", () => {
    const find = (section: string, fieldId: string) => SETTINGS_SEARCH_CATALOG.find((entry) => entry.section === section && entry.id === fieldId);
    expect(find("desktop-assistant", "recent-messages")?.label).toBe("Recent messages");
    expect(find("desktop-assistant", "recent")).toBeUndefined();
    expect(find("pi-tools-suite-assistant", "recent-messages")).toBeUndefined();
  });
});
