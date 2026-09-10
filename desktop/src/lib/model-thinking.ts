import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { modelRefTone, type ModelDisplayTone } from "./model-display";

export const CANONICAL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ModelThinkingModel {
  readonly ref: string;
  readonly name: string;
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevels: readonly string[];
  readonly current: boolean;
  readonly tone: ModelDisplayTone;
}

export interface ModelThinkingConfigState {
  readonly models: readonly ModelThinkingModel[];
  readonly currentModel?: ModelThinkingModel;
  readonly currentThinking: string;
  readonly currentThinkingLevels: readonly string[];
}

export function modelThinkingConfigState(configOptions: readonly SessionConfigOption[]): ModelThinkingConfigState {
  const modelOption = configOptions.find((option) => option.id === "model" && option.type === "select");
  const thinkingOption = configOptions.find((option) => option.id === "thought_level" && option.type === "select");
  const currentThinkingLevels = thinkingOption?.type === "select"
    ? thinkingOption.options.flatMap((entry) => "options" in entry
        ? entry.options.map((option) => String(option.value))
        : [String(entry.value)])
    : [];
  const currentThinking = thinkingOption?.type === "select"
    ? String(thinkingOption.currentValue)
    : "off";
  const currentModelRef = modelOption?.type === "select" ? String(modelOption.currentValue) : "";

  const models: ModelThinkingModel[] = [];
  if (modelOption?.type === "select") {
    for (const entry of modelOption.options) {
      const group = "options" in entry ? entry.name : undefined;
      const options = "options" in entry ? entry.options : [entry];
      for (const option of options) {
        const ref = String(option.value);
        const separator = ref.indexOf("/");
        const provider = separator > 0 ? ref.slice(0, separator) : group ?? "";
        const modelId = separator > 0 ? ref.slice(separator + 1) : ref;
        const metadataLevels = modelThinkingLevels(option._meta);
        const thinkingLevels = metadataLevels.length > 0
          ? metadataLevels
          : ref === currentModelRef && currentThinkingLevels.length > 0
            ? currentThinkingLevels
            : currentThinkingLevels.length > 0
              ? currentThinkingLevels
              : ["off"];
        models.push({
          ref,
          name: option.name,
          provider,
          modelId,
          thinkingLevels,
          current: ref === currentModelRef,
          tone: modelRefTone(ref),
        });
      }
    }
  }

  models.sort((left, right) => Number(right.current) - Number(left.current) || left.ref.localeCompare(right.ref));
  return {
    models,
    currentModel: models.find((model) => model.current),
    currentThinking,
    currentThinkingLevels,
  };
}

export function clampThinkingLevel(level: string, availableLevels: readonly string[]): string {
  const levels = availableLevels.length > 0 ? [...availableLevels] : ["off"];
  if (levels.includes(level)) return level;
  const requestedIndex = CANONICAL_THINKING_LEVELS.indexOf(level as (typeof CANONICAL_THINKING_LEVELS)[number]);
  if (requestedIndex === -1) return levels[0] ?? "off";
  for (let index = requestedIndex; index < CANONICAL_THINKING_LEVELS.length; index += 1) {
    const candidate = CANONICAL_THINKING_LEVELS[index];
    if (candidate && levels.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = CANONICAL_THINKING_LEVELS[index];
    if (candidate && levels.includes(candidate)) return candidate;
  }
  return levels[0] ?? "off";
}

function modelThinkingLevels(meta: Record<string, unknown> | null | undefined): string[] {
  const value = meta?.["pix.thinkingLevels"];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
}
