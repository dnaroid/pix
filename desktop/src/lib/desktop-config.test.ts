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
    expect(resolveDesktopPreferences(undefined, undefined).externalEditor).toBeUndefined();
    expect(EXTERNAL_EDITOR_OPTIONS).toContainEqual({ value: "gram", label: "Gram" });
    expect(externalEditorLabel("gram")).toBe("Gram");
    expect(externalEditorLabel("vscode")).toBe("VS Code");
    expect(externalEditorLabel("zed")).toBe("Zed");
    expect(externalEditorLabel(undefined)).toBe("External Editor");
  });
});
