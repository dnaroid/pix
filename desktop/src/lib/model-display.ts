export type ModelDisplayTone =
  | "muted"
  | "accent"
  | "info"
  | "search"
  | "mutation"
  | "success"
  | "warning"
  | "error"
  | "model-openai"
  | "thinking-xhigh"
  | "thinking-max";

export function modelDisplayToneClass(tone: ModelDisplayTone | undefined): string {
  switch (tone) {
    case "accent": return "text-tool-accent";
    case "info": return "text-tool-info";
    case "search": return "text-tool-search";
    case "mutation": return "text-tool-mutation";
    case "success": return "text-tool-success";
    case "warning": return "text-tool-warning";
    case "error": return "text-tool-error";
    case "model-openai": return "text-model-openai";
    case "thinking-xhigh": return "text-thinking-xhigh";
    case "thinking-max": return "text-thinking-max";
    case "muted": return "text-muted-foreground";
    default: return "text-foreground";
  }
}

const DEFAULT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MODEL_PROVIDER_PALETTE: readonly ModelDisplayTone[] = [
  "accent",
  "info",
  "search",
  "mutation",
  "success",
  "warning",
];
const THINKING_PALETTE: readonly ModelDisplayTone[] = [
  "muted",
  "success",
  "model-openai",
  "warning",
  "error",
  "thinking-xhigh",
  "thinking-max",
];

/** Mirrors the TUI's shipped modelColors rules, then its provider-hash fallback palette. */
export function modelRefTone(modelRef: string): ModelDisplayTone {
  const normalized = modelRef.trim().toLowerCase();
  if (/^antigravity\/antigravity-claude-/u.test(normalized)) return "error";
  if (normalized.startsWith("antigravity/")) return "warning";
  if (normalized.startsWith("openai-codex/")) return "model-openai";
  if (normalized.startsWith("zai/")) return "success";

  const provider = normalized.slice(0, Math.max(0, normalized.indexOf("/"))) || normalized;
  return MODEL_PROVIDER_PALETTE[hashString(provider) % MODEL_PROVIDER_PALETTE.length] ?? "info";
}

/** Mirrors the TUI's rank-based thinking palette, including reduced model-specific level sets. */
export function thinkingLevelTone(
  level: string,
  availableLevels: readonly string[] = DEFAULT_THINKING_LEVELS,
): ModelDisplayTone {
  const normalizedLevels = availableLevels.length > 0 ? availableLevels.map(String) : [...DEFAULT_THINKING_LEVELS];
  const rank = normalizedLevels.indexOf(level);
  if (rank >= 0) return thinkingRankTone(level, rank, normalizedLevels.length);

  const fallbackRank = DEFAULT_THINKING_LEVELS.indexOf(level as (typeof DEFAULT_THINKING_LEVELS)[number]);
  return fallbackRank >= 0
    ? thinkingRankTone(level, fallbackRank, DEFAULT_THINKING_LEVELS.length)
    : "info";
}

function thinkingRankTone(level: string, rank: number, count: number): ModelDisplayTone {
  const palette: readonly ModelDisplayTone[] = count > THINKING_PALETTE.length
    ? ["accent", ...THINKING_PALETTE]
    : THINKING_PALETTE;
  const fallbackRank = DEFAULT_THINKING_LEVELS.indexOf(level as (typeof DEFAULT_THINKING_LEVELS)[number]);
  const colorIndex = count <= THINKING_PALETTE.length && fallbackRank >= 0 ? fallbackRank : rank;
  return palette[Math.max(0, Math.min(palette.length - 1, colorIndex))] ?? "info";
}

function hashString(value: string): number {
  let hash = 1779033703 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return (hash ^ (hash >>> 16)) >>> 0;
}
