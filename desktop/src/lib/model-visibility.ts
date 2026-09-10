import { parseSettingsSource, updateSettingsSource } from "./settings";

export function visibleModelRefsFromPixConfig(source: string): string[] | undefined {
  const raw = parseSettingsSource(source).value.visibleModels;
  if (!Array.isArray(raw)) return undefined;
  return normalizeVisibleModelRefs(raw);
}

export function updateVisibleModelRefsInPixConfig(source: string, modelRefs: readonly string[]): string {
  return updateSettingsSource(source, ["visibleModels"], normalizeVisibleModelRefs(modelRefs));
}

function normalizeVisibleModelRefs(values: readonly unknown[]): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}
