import { parseSettingsSource, updateSettingsSource } from "./settings";
import { CANONICAL_THINKING_LEVELS } from "./model-thinking";

export type ModelThinkingPreferences = Record<string, string>;

export function modelThinkingPreferencesFromPixConfig(source: string): ModelThinkingPreferences {
  const raw = parseSettingsSource(source).value.thinkingByModel;
  if (!isRecord(raw)) return {};
  const preferences: ModelThinkingPreferences = {};
  for (const [modelRef, value] of Object.entries(raw)) {
    const normalizedRef = normalizeModelRef(modelRef);
    const thinking = normalizeThinkingLevel(value);
    if (normalizedRef && thinking) preferences[normalizedRef] = thinking;
  }
  return preferences;
}

export function updateModelThinkingPreferenceInPixConfig(
  source: string,
  modelRef: string,
  thinkingLevel: string,
): string {
  const normalizedRef = normalizeModelRef(modelRef);
  const thinking = normalizeThinkingLevel(thinkingLevel);
  if (!normalizedRef || !thinking) return source;
  return updateSettingsSource(source, ["thinkingByModel", normalizedRef], thinking);
}

function normalizeThinkingLevel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return CANONICAL_THINKING_LEVELS.includes(
    normalized as (typeof CANONICAL_THINKING_LEVELS)[number],
  ) ? normalized : undefined;
}

function normalizeModelRef(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const separator = trimmed.lastIndexOf(":");
  if (separator <= 0) return trimmed;
  const suffix = trimmed.slice(separator + 1).toLowerCase();
  return CANONICAL_THINKING_LEVELS.includes(
    suffix as (typeof CANONICAL_THINKING_LEVELS)[number],
  ) ? trimmed.slice(0, separator) : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
