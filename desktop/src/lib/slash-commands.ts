import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { fuzzySearch } from "./fuzzy";

export interface SlashCommandMatch {
  readonly command: AvailableCommand;
  readonly source?: string;
  readonly inputHint?: string;
}

export type DesktopSlashCommand =
  | { readonly kind: "new" | "resume" | "reload" | "model" | "thinking" }
  | { readonly kind: "fork"; readonly entryId?: string };

/** Commands implemented by Desktop chrome rather than the ACP session. */
export const DESKTOP_SLASH_COMMANDS: readonly AvailableCommand[] = [
  {
    name: "new",
    description: "Start a fresh conversation",
    _meta: { "pix.commandSource": "desktop" },
  },
  {
    name: "resume",
    description: "Open a saved conversation",
    _meta: { "pix.commandSource": "desktop" },
  },
  {
    name: "reload",
    description: "Reload extensions, skills, prompts, and context files",
    _meta: { "pix.commandSource": "desktop" },
  },
  {
    name: "fork",
    description: "Fork from the latest or specified user-message entry",
    _meta: {
      "pix.commandSource": "desktop",
      "pix.inputHint": "[entry-id]",
    },
  },
  {
    name: "model",
    description: "Select the active model",
    _meta: {
      "pix.commandSource": "desktop",
      "pix.inputHint": "[provider/model]",
      "pix.interactive": true,
    },
  },
  {
    name: "thinking",
    description: "Select the thinking level",
    _meta: {
      "pix.commandSource": "desktop",
      "pix.inputHint": "[level]",
      "pix.aliases": ["thought"],
      "pix.interactive": true,
    },
  },
];

/** Merge command catalogs with first-catalog precedence for names and aliases. */
export function mergeSlashCommands(
  ...catalogs: readonly (readonly AvailableCommand[])[]
): AvailableCommand[] {
  const merged: AvailableCommand[] = [];
  const reservedNames = new Set<string>();
  for (const catalog of catalogs) {
    for (const command of catalog) {
      const names = [command.name, ...commandAliases(command)].map((name) => name.toLowerCase());
      if (names.some((name) => reservedNames.has(name))) continue;
      merged.push(command);
      for (const name of names) reservedNames.add(name);
    }
  }
  return merged;
}

/** Recognize commands owned by Desktop; argument forms still fall through to ACP. */
export function parseDesktopSlashCommand(text: string, hasAttachments: boolean): DesktopSlashCommand | undefined {
  if (hasAttachments) return undefined;
  const normalized = text.trim().toLowerCase();
  if (normalized === "/new") return { kind: "new" };
  if (normalized === "/resume") return { kind: "resume" };
  if (normalized === "/reload") return { kind: "reload" };
  if (normalized === "/model") return { kind: "model" };
  if (normalized === "/thinking" || normalized === "/thought") return { kind: "thinking" };
  const fork = /^\/fork(?:\s+(\S+))?$/.exec(normalized);
  if (fork) return { kind: "fork", ...(fork[1] ? { entryId: fork[1] } : {}) };
  return undefined;
}

/** Return the slash query when the caret is at the end of a command name. */
export function slashCommandQuery(
  text: string,
  selectionStart: number,
  selectionEnd: number,
): string | undefined {
  if (selectionStart !== selectionEnd || selectionEnd !== text.length) return undefined;
  return /^\/(\S*)$/.exec(text)?.[1];
}

/** Fuzzy-match commands by name, aliases, description, and source. */
export function matchSlashCommands(
  commands: readonly AvailableCommand[],
  query: string,
  limit = 8,
): SlashCommandMatch[] {
  return fuzzySearch(
    commands.map((command) => {
      const aliases = commandAliases(command);
      const source = commandSource(command);
      const inputHint = slashCommandInputHint(command);
      return {
        value: {
          command,
          ...(source ? { source } : {}),
          ...(inputHint ? { inputHint } : {}),
        },
        label: command.name,
        ...(aliases.length > 0 ? { aliases } : {}),
        keywords: [command.description, source].filter((value): value is string => !!value),
      };
    }),
    query,
    { limit },
  ).map((match) => match.value);
}

/** Text inserted by accepting a command. Commands with input hints keep a trailing space. */
export function slashCommandInsertion(command: AvailableCommand): string {
  return `/${command.name}${slashCommandInputHint(command) ? " " : ""}`;
}

/** Commands without an argument hint can execute as soon as Enter accepts them. */
export function shouldSubmitAcceptedSlashCommand(match: SlashCommandMatch): boolean {
  return match.command.input === undefined;
}

export function slashCommandInputHint(command: AvailableCommand): string | undefined {
  if (command.input?.hint) return command.input.hint;
  const value = command._meta?.["pix.inputHint"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function commandAliases(command: AvailableCommand): string[] {
  const value = command._meta?.["pix.aliases"];
  return Array.isArray(value) ? value.filter((alias): alias is string => typeof alias === "string") : [];
}

function commandSource(command: AvailableCommand): string | undefined {
  const value = command._meta?.["pix.commandSource"];
  return typeof value === "string" ? value : undefined;
}
