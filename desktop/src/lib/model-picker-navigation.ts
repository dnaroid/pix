import { AUTO_MODEL_REF } from "./model-thinking";

/** Empty search preserves the staged/current model, even with Auto pinned first. */
export function pickerModelIndex(
  models: readonly { ref: string }[],
  stagedRef: string,
  query: string,
  visibilityMode: boolean,
): number {
  if (visibilityMode) return 0;
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return Math.max(0, models.findIndex((model) => model.ref === stagedRef));
  if (models[0]?.ref === AUTO_MODEL_REF && models.length > 1
    && !/^(?:auto|automatic|routing|router)/iu.test(normalizedQuery)) return 1;
  return 0;
}

export function nextPickerThinking(
  levels: readonly string[],
  current: string,
  direction: 1 | -1,
): string | undefined {
  if (levels.length === 0) return undefined;
  const index = Math.max(0, levels.indexOf(current));
  return levels[(index + direction + levels.length) % levels.length];
}
