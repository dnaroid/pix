import type { SessionConfigOption } from "@agentclientprotocol/sdk";

export type InteractiveSlashCommand = "model" | "thinking" | "jump" | "history";
type ConfigSlashCommand = Extract<InteractiveSlashCommand, "model" | "thinking">;

export interface CommandPickerItem {
  readonly id?: string;
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly current?: boolean;
}

export interface CommandPickerState {
  readonly command: InteractiveSlashCommand;
  readonly title: string;
  readonly placeholder: string;
  readonly emptyText: string;
  readonly initialQuery?: string;
  readonly items: readonly CommandPickerItem[];
}

export function commandPickerState(
  command: ConfigSlashCommand,
  configOptions: readonly SessionConfigOption[],
): CommandPickerState {
  const optionId = command === "model" ? "model" : "thought_level";
  const option = configOptions.find((candidate) => candidate.id === optionId && candidate.type === "select");
  const items = option?.type === "select"
    ? option.options.flatMap((entry) => "options" in entry
      ? entry.options.map((item) => ({
          value: item.value,
          label: item.name,
          description: command === "model" ? item.value : thinkingDescription(item.value),
          current: item.value === option.currentValue,
        }))
      : [{
          value: entry.value,
          label: entry.name,
          description: command === "model" ? entry.value : thinkingDescription(entry.value),
          current: entry.value === option.currentValue,
        }])
    : [];

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
    case "off": return "No extended reasoning";
    case "minimal": return "Fast, minimal reasoning";
    case "low": return "Light reasoning";
    case "medium": return "Balanced reasoning";
    case "high": return "Deeper reasoning";
    case "xhigh": return "Very deep reasoning";
    case "max": return "Maximum available reasoning";
    default: return "Reasoning effort";
  }
}
