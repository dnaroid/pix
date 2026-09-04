import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_SLASH_COMMANDS,
  matchSlashCommands,
  mergeSlashCommands,
  parseDesktopSlashCommand,
  shouldSubmitAcceptedSlashCommand,
  slashCommandInsertion,
  slashCommandQuery,
} from "./slash-commands";

const commands: AvailableCommand[] = [
  {
    name: "follow-up",
    description: "Set follow-up delivery mode",
    _meta: {
      "pix.commandSource": "builtin",
      "pix.aliases": ["followup"],
      "pix.inputHint": "[all | one-at-a-time]",
    },
  },
  {
    name: "review",
    description: "Review the current changes",
    _meta: { "pix.commandSource": "prompt" },
  },
];

describe("slash command helpers", () => {
  it("extracts a query only for a collapsed caret at the end of a command name", () => {
    expect(slashCommandQuery("/rev", 4, 4)).toBe("rev");
    expect(slashCommandQuery("/rev", 2, 2)).toBeUndefined();
    expect(slashCommandQuery("/rev", 1, 3)).toBeUndefined();
    expect(slashCommandQuery("/review now", 11, 11)).toBeUndefined();
    expect(slashCommandQuery("text /rev", 9, 9)).toBeUndefined();
  });

  it("matches names, aliases, descriptions, and sources", () => {
    expect(matchSlashCommands(commands, "rv").map(({ command }) => command.name)).toEqual(["review"]);
    expect(matchSlashCommands(commands, "followup").map(({ command }) => command.name)).toEqual(["follow-up"]);
    expect(matchSlashCommands(commands, "delivery").map(({ command }) => command.name)).toEqual(["follow-up"]);
    expect(matchSlashCommands(commands, "prompt").map(({ command }) => command.name)).toEqual(["review"]);
  });

  it("adds a trailing space for required or optional Pix input hints", () => {
    expect(slashCommandInsertion(commands[0]!)).toBe("/follow-up ");
    expect(slashCommandInsertion(commands[1]!)).toBe("/review");
    expect(slashCommandInsertion({
      name: "name",
      description: "Rename the session",
      input: { hint: "<name>" },
    })).toBe("/name ");
  });

  it("submits immediately unless the ACP command declares required input", () => {
    const matches = matchSlashCommands(commands, "");
    // Optional Pix hints no longer block Enter: Desktop owns argument UX.
    expect(shouldSubmitAcceptedSlashCommand(matches.find(({ command }) => command.name === "follow-up")!)).toBe(true);
    expect(shouldSubmitAcceptedSlashCommand(matches.find(({ command }) => command.name === "review")!)).toBe(true);
    expect(shouldSubmitAcceptedSlashCommand({
      command: { name: "name", description: "Rename the session", input: { hint: "<name>" } },
    })).toBe(false);
  });

  it("merges Desktop commands ahead of ACP names and aliases", () => {
    const merged = mergeSlashCommands(
      DESKTOP_SLASH_COMMANDS,
      [
        { name: "new", description: "runtime collision" },
        { name: "restore", description: "alias collision", _meta: { "pix.aliases": ["resume"] } },
        { name: "thought", description: "alias collision" },
        { name: "session", description: "Session stats" },
      ],
    );
    expect(merged.map((command) => command.name)).toEqual([
      "new",
      "resume",
      "reload",
      "fork",
      "model",
      "thinking",
      "session",
    ]);
  });

  it("recognizes only exact attachment-free Desktop command forms", () => {
    expect(parseDesktopSlashCommand("/new", false)).toEqual({ kind: "new" });
    expect(parseDesktopSlashCommand("/NEW", false)).toEqual({ kind: "new" });
    expect(parseDesktopSlashCommand("/new now", false)).toBeUndefined();
    expect(parseDesktopSlashCommand("/resume", true)).toBeUndefined();
    expect(parseDesktopSlashCommand("/reload", false)).toEqual({ kind: "reload" });
    expect(parseDesktopSlashCommand("/model", false)).toEqual({ kind: "model" });
    expect(parseDesktopSlashCommand("/thinking", false)).toEqual({ kind: "thinking" });
    expect(parseDesktopSlashCommand("/THOUGHT", false)).toEqual({ kind: "thinking" });
  });

  it("parses fork entry ids and rejects malformed arguments", () => {
    expect(parseDesktopSlashCommand("/fork", false)).toEqual({ kind: "fork" });
    expect(parseDesktopSlashCommand("/Fork entry-7", false)).toEqual({ kind: "fork", entryId: "entry-7" });
    expect(parseDesktopSlashCommand("/fork ", false)).toEqual({ kind: "fork" });
    expect(parseDesktopSlashCommand("/fork one two", false)).toBeUndefined();
    expect(parseDesktopSlashCommand("/fork entry-7", true)).toBeUndefined();
  });
});
