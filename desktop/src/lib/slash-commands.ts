import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { fuzzySearch } from "./fuzzy";

export interface SlashCommandMatch {
  readonly command: AvailableCommand;
  readonly source?: string;
  readonly inputHint?: string;
}

export type DesktopSlashCommand =
  | { readonly kind: "new" | "new_tab" | "reload" }
  | { readonly kind: "enhance"; readonly draft: string }
  | { readonly kind: "import"; readonly path?: string }
  | { readonly kind: "queue"; readonly message: string }
  | { readonly kind: "resume"; readonly path?: string }
  | { readonly kind: "search" | "delete" | "jump" | "history"; readonly query: string }
  | { readonly kind: "hotkeys" | "quit" }
  | { readonly kind: "model"; readonly value?: string }
  | { readonly kind: "thinking"; readonly level?: string }
  | { readonly kind: "fork"; readonly entryId?: string };

/** Commands implemented by Desktop chrome rather than the ACP session. */
export const DESKTOP_SLASH_COMMANDS: readonly AvailableCommand[] = [
  {
    name: "new",
    description: "Start a fresh conversation",
    _meta: { "pix.commandSource": "desktop" },
  },
  {
    name: "new_tab",
    description: "Open a fresh conversation in a new tab",
    _meta: { "pix.commandSource": "desktop" },
  },
  {
    name: "resume",
    description: "Open a saved conversation",
    _meta: {
      "pix.commandSource": "desktop",
      "pix.inputHint": "[session path]",
    },
  },
  {
    name: "reload",
    description: "Reload extensions, skills, prompts, and context files",
    _meta: { "pix.commandSource": "desktop" },
  },
  {
    name: "enhance",
    description: "Improve a prompt draft and put the result back in the composer",
    _meta: {
      "pix.commandSource": "desktop",
      "pix.inputHint": "[draft]",
    },
  },
  {
    name: "import",
    description: "Import and resume a session from a JSONL file",
    _meta: {
      "pix.commandSource": "desktop",
      "pix.inputHint": "[path.jsonl]",
    },
  },
  {
    name: "queue",
    description: "Pause a message and send it later from the queue",
    _meta: {
      "pix.commandSource": "desktop",
      "pix.inputHint": "<message>",
    },
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
    name: "search",
    description: "Search saved conversations",
    _meta: {
      "pix.commandSource": "desktop",
      "pix.inputHint": "[query]",
    },
  },
  {
    name: "jump",
    description: "Jump to a previous user message in this conversation",
    _meta: {
      "pix.commandSource": "desktop",
      "pix.inputHint": "[query]",
    },
  },
  {
    name: "history",
    description: "Search prompt history and restore a previous draft",
    _meta: {
      "pix.commandSource": "desktop",
      "pix.inputHint": "[query]",
    },
  },
  {
    name: "hotkeys",
    description: "Show Desktop keyboard shortcuts",
    _meta: { "pix.commandSource": "desktop" },
  },
  {
    name: "quit",
    description: "Quit Pix Desktop",
    _meta: { "pix.commandSource": "desktop" },
  },
  {
    name: "exit",
    description: "Quit Pix Desktop",
    _meta: { "pix.commandSource": "desktop" },
  },
  {
    name: "delete",
    description: "Choose and permanently delete a conversation",
    _meta: {
      "pix.commandSource": "desktop",
      "pix.inputHint": "[query]",
    },
  },
  {
    name: "model",
    description: "Select the active model",
    _meta: {
      "pix.commandSource": "desktop",
      "pix.inputHint": "[provider/model[:thinking]]",
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
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match?.[1]) return undefined;
  const name = match[1].toLowerCase();
  const rest = match[2]?.trim() ?? "";
  // /queue is allowed to capture the current attachment draft; all other
  // slash commands remain attachment-free.
  if (name === "queue") return { kind: "queue", message: rest };
  if (hasAttachments) return undefined;
  if (name === "new" && !rest) return { kind: "new" };
  if (name === "new_tab" && !rest) return { kind: "new_tab" };
  if (name === "reload" && !rest) return { kind: "reload" };
  if (name === "enhance") return { kind: "enhance", draft: rest };
  if (name === "import") return { kind: "import", ...(rest ? { path: commandPathArgument(rest) } : {}) };
  if (name === "resume") return { kind: "resume", ...(rest ? { path: commandPathArgument(rest) } : {}) };
  if (name === "search") return { kind: "search", query: rest };
  if (name === "delete") return { kind: "delete", query: rest };
  if (name === "jump") return { kind: "jump", query: rest };
  if (name === "history") return { kind: "history", query: rest };
  if (name === "hotkeys" && !rest) return { kind: "hotkeys" };
  if ((name === "quit" || name === "exit") && !rest) return { kind: "quit" };
  if (name === "model") return { kind: "model", ...(rest ? { value: rest } : {}) };
  if (name === "thinking" || name === "thought") return { kind: "thinking", ...(rest ? { level: rest } : {}) };
  if (name === "fork" && (!rest || !/\s/u.test(rest))) return { kind: "fork", ...(rest ? { entryId: rest } : {}) };
  return undefined;
}

function commandPathArgument(value: string): string {
  const quote = value[0];
  if (quote === "\"" || quote === "'") {
    const end = value.indexOf(quote, 1);
    return end < 0 ? value.slice(1) : value.slice(1, end);
  }
  return value.split(/\s+/u)[0] ?? value;
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
  limit?: number,
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
    limit === undefined ? {} : { limit },
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
