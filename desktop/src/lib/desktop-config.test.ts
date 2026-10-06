import { describe, expect, it } from "vitest";
import {
  EXTERNAL_EDITOR_OPTIONS,
  externalEditorLabel,
  resolveDesktopPreferences,
} from "./desktop-config";

describe("desktop config", () => {
  it("uses project editor over the global editor", () => {
    expect(resolveDesktopPreferences(
      `{ "desktop": { "externalEditor": "code" } }`,
      `{ // project override\n "desktop": { "externalEditor": "cursor", },\n}`,
    ).externalEditor).toBe("cursor");
  });

  it("requires an explicit editor and formats known editor labels", () => {
    const defaults = resolveDesktopPreferences(undefined, undefined);
    expect(defaults.externalEditor).toBeUndefined();
    expect(defaults.notificationsEnabled).toBe(true);
    expect(defaults.gitCiFixModelRef).toBeUndefined();
    expect(defaults.knowledgeReviewModelRef).toBeUndefined();
    expect(EXTERNAL_EDITOR_OPTIONS).toContainEqual({ value: "gram", label: "Gram" });
    expect(externalEditorLabel("gram")).toBe("Gram");
    expect(externalEditorLabel("vscode")).toBe("VS Code");
    expect(externalEditorLabel("zed")).toBe("Zed");
    expect(externalEditorLabel(undefined)).toBe("External Editor");
  });

  it("uses project notification preference over global and keeps legacy configs enabled", () => {
    expect(resolveDesktopPreferences(
      `{ "desktop": { "notifications": { "enabled": false } } }`,
      undefined,
    ).notificationsEnabled).toBe(false);
    expect(resolveDesktopPreferences(
      `{ "desktop": { "notifications": { "enabled": false } } }`,
      `{ "desktop": { "notifications": { "enabled": true } } }`,
    ).notificationsEnabled).toBe(true);
    expect(resolveDesktopPreferences(`{ "desktop": {} }`, undefined).notificationsEnabled).toBe(true);
  });

  it("uses the project CI fix model over the global model and leaves it unset by default", () => {
    expect(resolveDesktopPreferences(
      `{ "desktop": { "git": { "ciFixModelRef": "openai-codex/gpt-5.3:high" } } }`,
      undefined,
    ).gitCiFixModelRef).toBe("openai-codex/gpt-5.3:high");
    expect(resolveDesktopPreferences(
      `{ "desktop": { "git": { "ciFixModelRef": "openai-codex/gpt-5.3:high" } } }`,
      `{ "desktop": { "git": { "ciFixModelRef": "anthropic/claude-sonnet-4-5" } } }`,
    ).gitCiFixModelRef).toBe("anthropic/claude-sonnet-4-5");
  });

  it("resolves knowledge review model with project precedence and ignores empty/non-string overrides", () => {
    const global = `{ "desktop": { "knowledge": { "reviewModelRef": "provider/global:high" } } }`;
    expect(resolveDesktopPreferences(global, undefined).knowledgeReviewModelRef).toBe("provider/global:high");
    expect(resolveDesktopPreferences(global,
      `{ // override\n "desktop": { "knowledge": { "reviewModelRef": " provider/project:off ", }, }, }`,
    ).knowledgeReviewModelRef).toBe("provider/project:off");
    for (const value of ['" "', "false", "null"]) {
      expect(resolveDesktopPreferences(global,
        `{ "desktop": { "knowledge": { "reviewModelRef": ${value} } } }`,
      ).knowledgeReviewModelRef).toBe("provider/global:high");
    }
  });
});
