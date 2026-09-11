import { describe, expect, it } from "vitest";
import {
  desktopCommandDefinition,
  desktopCommandShortcutLabel,
  isDesktopCommandId,
  matchesDesktopShortcut,
} from "./desktop-commands";

describe("desktop commands", () => {
  it("keeps command metadata centralized", () => {
    expect(desktopCommandDefinition("session.new")).toMatchObject({
      label: "New Conversation",
      scope: "session",
    });
    expect(isDesktopCommandId("message.undo")).toBe(true);
    expect(isDesktopCommandId("unknown.command")).toBe(false);
  });

  it("formats primary shortcuts per desktop platform", () => {
    expect(desktopCommandShortcutLabel("application.commandPalette", "mac")).toBe("⌘⇧P");
    expect(desktopCommandShortcutLabel("application.commandPalette", "other")).toBe("Ctrl+Shift+P");
    expect(desktopCommandShortcutLabel("session.new", "mac")).toBe("⌘T");
  });

  it("matches only the platform primary modifier and requested modifiers", () => {
    const base = { key: "p", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false };
    const shortcut = desktopCommandDefinition("application.commandPalette").shortcut;
    expect(matchesDesktopShortcut(base, shortcut, "mac")).toBe(true);
    expect(matchesDesktopShortcut({ ...base, shiftKey: false }, shortcut, "mac")).toBe(false);
    expect(matchesDesktopShortcut({ ...base, ctrlKey: true }, shortcut, "mac")).toBe(false);
    expect(matchesDesktopShortcut({ ...base, metaKey: false, ctrlKey: true }, shortcut, "other")).toBe(true);
  });
});
