import { parseSettingsSource, updateSettingsSource } from "./settings";
import { CANONICAL_THINKING_LEVELS } from "./model-thinking";

export type ModelDefaultSelection =
  | { kind: "auto" }
  | { kind: "model"; modelRef: string; thinking: string };

export function modelDefaultSelectionFromPixConfig(source: string): ModelDefaultSelection | undefined {
  const root = parseSettingsSource(source).value;
  const routing = isRecord(root.modelRouting) ? root.modelRouting : undefined;
  if (routing?.default === true) return { kind: "auto" };

  const configured = root.defaultModel;
  if (typeof configured === "string") return parseModelSelection(configured);
  if (!isRecord(configured)) return undefined;
  const modelRef = typeof configured.modelRef === "string"
    ? configured.modelRef
    : typeof configured.model === "string"
      ? configured.model
      : "";
  const parsed = parseModelSelection(modelRef);
  if (!parsed || parsed.kind !== "model") return undefined;
  const thinking = normalizeThinking(configured.thinking)
    ?? normalizeThinking(configured.thinkingLevel)
    ?? parsed.thinking;
  return { kind: "model", modelRef: parsed.modelRef, thinking };
}

export function updateModelDefaultSelectionInPixConfig(
  source: string,
  selection: ModelDefaultSelection,
): string {
  if (selection.kind === "auto") {
    let updated = updateSettingsSource(source, ["modelRouting", "enabled"], true);
    updated = updateSettingsSource(updated, ["modelRouting", "default"], true);
    return updated;
  }

  const normalized = parseModelSelection(`${selection.modelRef}:${selection.thinking}`);
  if (!normalized || normalized.kind !== "model") return source;
  const root = parseSettingsSource(source).value;
  const current = isRecord(root.defaultModel) ? root.defaultModel : undefined;
  const fallbackModels = Array.isArray(current?.fallbackModels)
    ? current.fallbackModels.filter((value: unknown): value is string => typeof value === "string")
    : [];
  let updated = updateSettingsSource(source, ["defaultModel"], {
    modelRef: normalized.modelRef,
    fallbackModels,
    thinking: normalized.thinking,
  });
  updated = updateSettingsSource(updated, ["modelRouting", "default"], false);
  return updated;
}

function parseModelSelection(value: string): ModelDefaultSelection | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const separator = trimmed.lastIndexOf(":");
  const suffix = separator > 0 ? normalizeThinking(trimmed.slice(separator + 1)) : undefined;
  const modelRef = suffix ? trimmed.slice(0, separator) : trimmed;
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) return undefined;
  return { kind: "model", modelRef, thinking: suffix ?? "off" };
}

function normalizeThinking(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return CANONICAL_THINKING_LEVELS.includes(
    normalized as (typeof CANONICAL_THINKING_LEVELS)[number],
  ) ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
