import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTERNAL_EDITOR,
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

  it("falls back to Zed and formats known editor labels", () => {
    expect(resolveDesktopPreferences(undefined, undefined).externalEditor).toBe(DEFAULT_EXTERNAL_EDITOR);
    expect(externalEditorLabel("vscode")).toBe("VS Code");
    expect(externalEditorLabel("zed")).toBe("Zed");
  });
});
