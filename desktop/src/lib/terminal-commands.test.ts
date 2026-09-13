import { describe, expect, it } from "vitest";
import { parseDesktopTerminalCommand } from "./terminal-commands";

describe("parseDesktopTerminalCommand", () => {
  it("parses TUI-compatible ! and !! commands", () => {
    expect(parseDesktopTerminalCommand("!pwd")).toEqual({
      kind: "chat",
      command: "pwd",
    });
    expect(parseDesktopTerminalCommand("  !!  git status  ")).toEqual({
      kind: "interactive",
      command: "git status",
    });
  });

  it("leaves empty bang prefixes as ordinary prompts", () => {
    expect(parseDesktopTerminalCommand("!")).toBeUndefined();
    expect(parseDesktopTerminalCommand("!!   ")).toBeUndefined();
    expect(parseDesktopTerminalCommand("hello !pwd")).toBeUndefined();
  });
});
