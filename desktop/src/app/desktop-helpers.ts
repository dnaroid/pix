export function normalizedPromptText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function compactPickerText(value: string, maxLength: number): string {
  const compact = normalizedPromptText(value);
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function parseDesktopModelRef(value: string): { modelRef: string; thinking?: string } | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const colon = trimmed.lastIndexOf(":");
  if (colon <= slash) return { modelRef: trimmed };
  const suffix = trimmed.slice(colon + 1).toLowerCase();
  if (!thinkingLevels.has(suffix)) return null;
  return { modelRef: trimmed.slice(0, colon), thinking: suffix };
}
