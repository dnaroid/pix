import { describe, expect, it } from "vitest";
import source from "./NativeSemanticSettings.svelte?raw";
import preferences from "./SettingsSearchPreferences.svelte?raw";
import editor from "./SettingsConfigEditor.svelte?raw";
import sidebar from "../WorkspaceSidebar.svelte?raw";
import panel from "../SettingsPanel.svelte?raw";
import { SETTINGS_SEARCH_CATALOG } from "../../lib/settings-search-catalog";

describe("global semantic settings contract", () => {
  it("edits an optional independent reranker through the same saved suite draft", () => {
    expect(source).toContain('["search", "rerankerModel"]');
    expect(source).toContain('label="Reranker model"');
    expect(source).toContain('aria-label="Reranker model"');
    expect(source).toContain("removeSettingsValue(source, path)");
    expect(source).toContain("lexical search stays local");
    expect(source).toContain("bounded Code/Knowledge text and Sessions/Tasks/Commits titles/snippets");
    expect(source).toContain("Settings stay local");
    expect(SETTINGS_SEARCH_CATALOG.find(entry => entry.section === "pi-tools-suite-search" && entry.id === "reranker-model")?.label).toBe("Reranker model");
  });
  it("uses native configuration rather than ACP or independent consent flags", () => {
    expect(source).not.toContain("invoke");
    expect(source).toContain('removeSettingsValue(source, ["search", "embedding"])');
    expect(editor).toContain('"write_user_config_if_unchanged"');
    expect(source).toContain("all sources, projects, Pi and Desktop");
    expect(source).toContain("~/.config/pi/pi-tools-suite.jsonc");
    expect(source).toContain("search.embedding");
    expect(source).toContain("task titles/descriptions, saved session names, commit metadata, settings metadata");
    expect(source).toContain("Public user/assistant message text on saved session branches is automatically indexed");
    expect(source).toContain("including existing history");
    expect(source).toContain("Tool results, thinking blocks and attachments are excluded");
    expect(source).not.toContain("confirm(");
    for (const legacy of ["tasksSemanticEnabled", "sessionTitlesEnabled", "settingsEnabled"]) {
      expect(preferences).not.toContain(legacy);
      expect(source).not.toContain(legacy);
    }
  });
  it("uses the shared custom selector and a single suite draft/save path", () => {
    expect(source).toContain("<TaskFieldSelect");
    expect(source).not.toContain("<select");
    expect(source).not.toContain("<button");
    expect(editor).toContain('<NativeSemanticSettings source={active.source} onChange={updateSource} />');
    expect(editor).toContain('if (kind === "pi-tools-suite") window.dispatchEvent(new CustomEvent("pix-semantic-config-changed"))');
    expect(source).toContain('return typeof value === "string" ? value : ""');
  });
  it("offers one Save action in the sticky settings header and keeps validation errors visible", () => {
    expect(editor).toContain('<header class="sticky top-0');
    expect(editor.match(/onclick=\{\(\) => void save\(\)\}/g)).toHaveLength(1);
    expect(editor).toContain("{#if error || (active && issues.length > 0)}");
    expect(editor).toContain("{issues[0]}");
    expect(editor).not.toContain("Changes may require a new or reloaded session.");
  });
  it("deep-links to the authored model field, including delayed config mounting", () => {
    expect(sidebar).toContain('onSettings={() => void openSettingsField("pi-tools-suite-search", "embedding-model")}');
    expect(SETTINGS_SEARCH_CATALOG.find(entry => entry.section === "pi-tools-suite-search" && entry.id === "embedding-model")?.label).toBe("Embedding model");
    expect(source).toContain('<SettingsFieldRow label="Embedding model"');
    expect(source).toContain('aria-label="Embedding model"');
    expect(panel).toContain("requestedField && next.includes(requestedField.section) && navigateField");
    expect(panel).toContain("(control ?? row).focus({ preventScroll: true })");
  });
});
