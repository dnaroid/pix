import { fuzzySearch } from "./fuzzy";
import type { ModelThinkingModel } from "./model-thinking";

export interface SettingsModelSearchOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly keywords?: readonly string[];
}

export function settingsModelSearchOptions(
  models: readonly ModelThinkingModel[],
): SettingsModelSearchOption[] {
  return models.map((model) => ({
    value: model.ref,
    label: settingsModelLabel(model),
    description: model.ref,
    aliases: [model.ref, model.modelId, model.name, model.provider],
    keywords: [model.name, `${model.provider} ${model.modelId}`],
  }));
}

/**
 * Display name only. The id restates the name ("GPT-6 Astra" / "gpt-6-astra"),
 * so it stays out of the label; the full provider/model ref is the option
 * description and remains searchable.
 */
export function settingsModelLabel(model: Pick<ModelThinkingModel, "name" | "modelId">): string {
  return model.name.trim() || model.modelId;
}

export function searchSettingsModelOptions(
  options: readonly SettingsModelSearchOption[],
  query: string,
  allowCustom = false,
): SettingsModelSearchOption[] {
  const matches = fuzzySearch(
    options.map((option) => ({
      value: option,
      label: option.label,
      aliases: [option.value, ...(option.aliases ?? [])],
      keywords: [option.description ?? "", ...(option.keywords ?? [])],
    })),
    query,
  ).map((match) => match.value);
  const customValue = query.trim();
  if (allowCustom && customValue && !options.some((option) => option.value === customValue)) {
    matches.unshift({ value: customValue, label: `Use “${customValue}”`, description: "Custom model or pattern" });
  }
  return matches;
}

export function searchSettingsModels(
  models: readonly ModelThinkingModel[],
  query: string,
): ModelThinkingModel[] {
  return fuzzySearch(
    models.map((model) => ({
      value: model,
      label: model.ref,
      aliases: [model.modelId, model.name, model.provider],
      keywords: [model.name, `${model.provider} ${model.modelId}`],
    })),
    query,
  ).map((match) => match.value);
}
