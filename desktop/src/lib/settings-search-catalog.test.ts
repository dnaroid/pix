import { describe, expect, it } from "vitest";
import desktopEditorSource from "../components/settings/DesktopSettingsEditor.svelte?raw";
import toolsEditorSource from "../components/settings/ToolsSuiteSettingsEditor.svelte?raw";
import searchPreferencesSource from "../components/settings/SettingsSearchPreferences.svelte?raw";
import { SETTINGS_SEARCH_CATALOG, settingsFieldId } from "./settings-search-catalog";

describe("authored settings search catalogue", () => {
  it("shows the shared embedding model and provider independently of connection or consent", () => {
    const modelRow = searchPreferencesSource.indexOf("Embedding model:");
    expect(modelRow).toBeGreaterThan(-1);
    expect(searchPreferencesSource).toContain("{SEARCH_EMBEDDING_MODEL}");
    expect(searchPreferencesSource).toContain("SEARCH_EMBEDDING_MODEL, type SearchConfigRequest, type SearchStatus");
    expect(searchPreferencesSource).toContain("Provider: ");
    expect(searchPreferencesSource).toContain("OpenRouter</dd>");
    expect(modelRow).toBeLessThan(searchPreferencesSource.indexOf("{#if client}"));
  });

  it("separates semantic-index consent from explicitly disclosed RAG evidence transfer", () => {
    expect(searchPreferencesSource).toContain("Settings semantic search sends only authored settings labels/descriptions");
    expect(searchPreferencesSource).toContain("Session titles and task descriptions each require their own separate opt-in");
    expect(searchPreferencesSource).toContain("tasksSemanticEnabled");
    expect(searchPreferencesSource).toContain("Enable semantic project-task search");
    expect(searchPreferencesSource).toContain("Semantic indexing never uploads conversation history or attachments");
    expect(searchPreferencesSource).toContain("session excerpts) and the question are sent to the selected RAG model provider");
    expect(desktopEditorSource).toContain('label="RAG answer model"');
    expect(desktopEditorSource).toContain('label="RAG thinking effort"');
    expect(searchPreferencesSource).toContain("sessionTitlesEnabled");
    expect(searchPreferencesSource).toContain("Never sends first-message fallback titles");
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
    expect(SETTINGS_SEARCH_CATALOG.find(entry => entry.id === "semantic-search")?.description).toContain("Separate opt-ins");
    expect(SETTINGS_SEARCH_CATALOG.find(entry => entry.id === "semantic-search")?.description).toContain("First-message fallback titles");
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
