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
    expect(defaults.soundOnlyEnabled).toBe(false);
    expect(defaults.gitCiFixModelRef).toBeUndefined();
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

  it("defaults to macOS notifications and allows a project to override sound-only mode", () => {
    const global = `{ "desktop": { "notifications": { "enabled": true, "usePix": true } } }`;
    const project = `{ "desktop": { "notifications": { "usePix": false } } }`;
    expect(resolveDesktopPreferences(global, undefined).soundOnlyEnabled).toBe(true);
    expect(resolveDesktopPreferences(global, project).soundOnlyEnabled).toBe(false);
    expect(resolveDesktopPreferences(global,
      `{ "desktop": { "notifications": { "usePix": "no" } } }`,
    ).soundOnlyEnabled).toBe(true);
    expect(resolveDesktopPreferences(undefined, undefined).soundOnlyEnabled).toBe(false);
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

  it("ignores legacy knowledge review settings", () => {
    expect(resolveDesktopPreferences(
      `{ "desktop": { "knowledge": { "reviewModelRef": "provider/global:high" } } }`,
      `{ "desktop": { "knowledge": { "reviewModelRef": "provider/project:off" } } }`,
    )).toEqual(resolveDesktopPreferences(undefined, undefined));
  });

  it("reads the project logo model with project precedence", () => {
    expect(resolveDesktopPreferences(undefined, undefined).projectIconModel).toBeUndefined();
    expect(resolveDesktopPreferences(
      '{"desktop":{"projectIcon":{"model":"global/model"}}}',
      '{"desktop":{"projectIcon":{"model":" project/model "}}}',
    ).projectIconModel).toBe("project/model");
    expect(resolveDesktopPreferences('{"desktop":{"projectIcon":{"model":"global/model"}}}', undefined)
      .projectIconModel).toBe("global/model");
  });
});
