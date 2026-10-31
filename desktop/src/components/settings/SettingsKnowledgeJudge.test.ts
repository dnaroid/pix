import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { ModelThinkingModel } from "../../lib/model-thinking";
import SettingsKnowledgeJudge from "./SettingsKnowledgeJudge.svelte";
import DesktopSettingsEditor from "./DesktopSettingsEditor.svelte";
import ToolsSuiteSettingsEditor from "./ToolsSuiteSettingsEditor.svelte";
import desktopSchemaSource from "../../../../schemas/pix-desktop.json?raw";
import suiteSchemaSource from "../../../../schemas/pi-tools-suite.json?raw";
import { SETTINGS_SEARCH_CATALOG } from "../../lib/settings-search-catalog";

const model: ModelThinkingModel = { ref: "test/judge", provider: "test", modelId: "judge", name: "Judge",
  thinkingLevels: ["off", "low", "high"], current: false, tone: "muted" };
const renderJudge = (source: string, desktop = false) => render(SettingsKnowledgeJudge, {
  props: { source, models: [model], desktop },
}).body;

describe("wizard-managed Wiki judge summary", () => {
  it("renders read-only model and reasoning with the shared Edit in wizard action", () => {
    const html = renderJudge('{"knowledgeCheck":{"modelRef":"test/judge","thinking":"high"}}');
    expect(html).toContain("Contradiction judge model");
    expect(html).toContain('aria-label="Contradiction judge thinking"');
    expect(html).toContain('title="test/judge"');
    expect(html).toContain("Judge");
    expect(html).toContain("high");
    expect(html).not.toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("<select");
    expect(html).toContain("Edit in wizard");
    expect(html).not.toContain("Reset to default");
  });
  it("discloses Desktop inheritance and Suite missing-judge defaults", () => {
    const desktop = renderJudge("{}", true), suite = renderJudge("{}");
    expect(desktop).toContain("Use Tools Suite setting");
    expect(desktop).toContain("Tools Suite setting (Low when unset)");
    expect(suite).toContain("No judge selected");
    expect(suite).toContain("low");
    expect(suite).toContain("Search and session models are not fallbacks");
  });
  it("keeps a configured judge visible when it is absent from the current model catalog", () => {
    const html = renderJudge('{"knowledgeCheck":{"modelRef":"custom/judge","thinking":"max"}}', true);
    expect(html).toContain('title="custom/judge"');
    expect(html).toContain("max");
  });
  it("does not show RAG preferences as the effective judge", () => {
    const html = renderJudge('{"search":{"ragModelRef":"search/other","ragThinking":"max"}}', true);
    expect(html).toContain("Use Tools Suite setting");
    expect(html).not.toContain("search/other");
  });
  it("mounts both controls in the intended settings sections and search destinations", () => {
    const desktop = render(DesktopSettingsEditor, { props: { source: "{}", schema: JSON.parse(desktopSchemaSource),
      models: [model], section: "assistant", onChange: () => {} } }).body;
    const suite = render(ToolsSuiteSettingsEditor, { props: { source: "{}", schema: JSON.parse(suiteSchemaSource),
      models: [model], section: "general", onChange: () => {} } }).body;
    for (const html of [desktop, suite]) {
      expect(html).toContain("Contradiction judge model");
      expect(html).toContain('aria-label="Contradiction judge thinking"');
      expect(html).toContain("Edit in wizard");
    }
    for (const [id, key] of [["contradiction-judge-model", "modelRef"], ["contradiction-judge-thinking", "thinking"]]) {
      const entries = SETTINGS_SEARCH_CATALOG.filter(entry => entry.id === id);
      expect(entries.map(entry => entry.section).sort()).toEqual(["desktop-assistant", "pi-tools-suite-general"]);
      for (const entry of entries) expect(entry.synonyms).toContain(`knowledgeCheck.${key}`);
    }
  });
});
