import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  desktopShortcutLabel,
  type DesktopCommandDefinition,
  type DesktopShortcutPlatform,
} from "./desktop-commands";
import { modelRefTone, thinkingLevelTone, type ModelDisplayTone } from "./model-display";

export type InteractiveSlashCommand = "model" | "thinking" | "jump" | "history";
export type CommandPickerKind = InteractiveSlashCommand | "commands";
type ConfigSlashCommand = Extract<InteractiveSlashCommand, "model" | "thinking">;

export interface CommandPickerItem {
  readonly id?: string;
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly current?: boolean;
  readonly aliases?: readonly string[];
  readonly keywords?: readonly string[];
  readonly tone?: ModelDisplayTone;
  readonly shortcut?: string;
}

export interface CommandPickerState {
  readonly command: CommandPickerKind;
  readonly title: string;
  readonly placeholder: string;
  readonly emptyText: string;
  readonly initialQuery?: string;
  readonly items: readonly CommandPickerItem[];
}

export function desktopCommandPickerState(
  commands: readonly DesktopCommandDefinition[],
  platform: DesktopShortcutPlatform,
): CommandPickerState {
  return {
    command: "commands",
    title: "Command Palette",
    placeholder: "Search commands…",
    emptyText: "No matching commands",
    items: commands.map((command) => ({
      id: command.id,
      value: command.id,
      label: command.label,
      description: command.description,
      aliases: [command.scope],
      keywords: command.keywords,
      shortcut: desktopShortcutLabel(command.shortcut, platform),
    })),
  };
}

type ConfigSelectValue = {
  readonly value: string;
  readonly name: string;
  readonly group?: string;
};

export function commandPickerState(
  command: ConfigSlashCommand,
  configOptions: readonly SessionConfigOption[],
): CommandPickerState {
  const optionId = command === "model" ? "model" : "thought_level";
  const option = configOptions.find((candidate) => candidate.id === optionId && candidate.type === "select");
  const values = option?.type === "select" ? configSelectValues(option) : [];
  const availableThinkingLevels = command === "thinking" ? values.map((item) => item.value) : [];
  const items: CommandPickerItem[] = command === "model"
    ? values
        .map((item) => {
          const separator = item.value.indexOf("/");
          const provider = separator > 0 ? item.value.slice(0, separator) : item.group ?? "";
          const modelId = separator > 0 ? item.value.slice(separator + 1) : item.value;
          return {
            value: item.value,
            label: item.value,
            description: item.name,
            current: item.value === option?.currentValue,
            aliases: [item.name, provider, modelId, item.group ?? ""].filter(Boolean),
            keywords: [item.name, `${provider} ${modelId}`, item.group ?? ""].filter(Boolean),
            tone: modelRefTone(item.value),
          };
        })
        .sort((left, right) => Number(right.current) - Number(left.current) || left.value.localeCompare(right.value))
    : values.map((item) => ({
        value: item.value,
        label: item.value,
        description: thinkingDescription(item.value),
        current: item.value === option?.currentValue,
        aliases: item.name === item.value ? [] : [item.name],
        keywords: thinkingKeywords(item.value),
        tone: thinkingLevelTone(item.value, availableThinkingLevels),
      }));

  return command === "model"
    ? {
        command,
        title: "Select model",
        placeholder: "Search models…",
        emptyText: "No matching models",
        items,
      }
    : {
        command,
        title: "Select thinking level",
        placeholder: "Search thinking levels…",
        emptyText: "No matching thinking levels",
        items,
      };
}

function configSelectValues(option: Extract<SessionConfigOption, { type: "select" }>): ConfigSelectValue[] {
  const values: ConfigSelectValue[] = [];
  for (const entry of option.options) {
    if ("options" in entry) {
      for (const item of entry.options) {
        values.push({ value: item.value, name: item.name, group: entry.name });
      }
    } else {
      values.push({ value: entry.value, name: entry.name });
    }
  }
  return values;
}

export function listCommandPickerState(
  command: Extract<InteractiveSlashCommand, "jump" | "history">,
  items: readonly CommandPickerItem[],
  initialQuery = "",
): CommandPickerState {
  return command === "jump"
    ? {
        command,
        title: "Jump to user message",
        placeholder: "Search messages…",
        emptyText: "No matching user messages",
        ...(initialQuery ? { initialQuery } : {}),
        items,
      }
    : {
        command,
        title: "Prompt history",
        placeholder: "Search prompt history…",
        emptyText: "Prompt history is empty",
        ...(initialQuery ? { initialQuery } : {}),
        items,
      };
}

function thinkingDescription(level: string): string {
  switch (level) {
    case "off": return "No reasoning/thinking";
    case "minimal": return "Minimal reasoning";
    case "low": return "Low reasoning";
    case "medium": return "Medium reasoning";
    case "high": return "High reasoning";
    case "xhigh": return "Extra high reasoning";
    case "max": return "Maximum reasoning";
    default: return "Reasoning effort";
  }
}

function thinkingKeywords(level: string): string[] {
  return [
    level === "off" ? "disabled none no reasoning" : "reasoning thinking effort",
    level === "minimal" ? "fast small" : "",
    level === "xhigh" ? "extra highest maximum" : "",
    level === "max" ? "maximum most" : "",
  ].filter(Boolean);
}
