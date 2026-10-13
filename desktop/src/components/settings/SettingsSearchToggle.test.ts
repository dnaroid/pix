import { describe, expect, it } from "vitest";
import toggle from "./SettingsSearchToggle.svelte?raw";
import preferences from "./SettingsSearchPreferences.svelte?raw";
import { SETTINGS_SEARCH_CATALOG } from "../../lib/settings-search-catalog";

describe("global Settings search preference", () => {
  it("uses the same immediate global policy control as the index panel", () => {
    expect(preferences).toContain("<SettingsSearchToggle {cwd}");
    expect(toggle).toContain('setSearchSourceSelection(cwd, "settings", value, controller.signal)');
    expect(toggle).toContain('aria-label="Search settings across all projects"');
    expect(toggle).toContain("enabled === null || saving");
    expect(SETTINGS_SEARCH_CATALOG.some(entry => entry.label === "Search settings")).toBe(true);
  });
  it("refreshes after shared changes and tears down subscriptions and requests", () => {
    expect(toggle).toContain("window.addEventListener(SEARCH_SOURCE_SELECTION_CHANGED, refresh)");
    expect(toggle).toContain("window.removeEventListener(SEARCH_SOURCE_SELECTION_CHANGED, refresh)");
    expect(toggle).toContain("controller.abort()");
    expect(toggle).toContain("revision === current");
  });
});
