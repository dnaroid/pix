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
    label: `${model.name} · ${model.modelId}`,
    description: model.ref,
    aliases: [model.ref, model.modelId, model.name, model.provider],
    keywords: [model.name, `${model.provider} ${model.modelId}`],
  }));
}

export function searchSettingsModelOptions(
  options: readonly SettingsModelSearchOption[],
  query: string,
): SettingsModelSearchOption[] {
  return fuzzySearch(
    options.map((option) => ({
      value: option,
      label: option.label,
      aliases: [option.value, ...(option.aliases ?? [])],
      keywords: [option.description ?? "", ...(option.keywords ?? [])],
    })),
    query,
  ).map((match) => match.value);
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
