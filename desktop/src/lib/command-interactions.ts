import type { SessionConfigOption } from "@agentclientprotocol/sdk";

export type InteractiveSlashCommand = "model" | "thinking";

export interface CommandPickerItem {
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
  readonly items: readonly CommandPickerItem[];
}

export function commandPickerState(
  command: InteractiveSlashCommand,
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
