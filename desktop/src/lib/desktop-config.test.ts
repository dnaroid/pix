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
});
