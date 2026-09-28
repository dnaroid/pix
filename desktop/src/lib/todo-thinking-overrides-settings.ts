import { CANONICAL_THINKING_LEVELS } from "./model-thinking";
import { removeSettingsValue, updateSettingsSource } from "./settings";

export type TodoThinkingOverrideValue = string | null;

export interface TodoThinkingOverrideRow {
  readonly pattern: string;
  readonly level: TodoThinkingOverrideValue;
  readonly inherited: boolean;
  readonly explicit: boolean;
}

export const TODO_THINKING_LEVEL_OPTIONS = CANONICAL_THINKING_LEVELS.map((level) => ({
  value: level,
  label: level === "xhigh"
    ? "Extra high"
    : level.slice(0, 1).toUpperCase() + level.slice(1),
}));

export function todoThinkingOverrideRows(
  inheritedValue: unknown,
  explicitValue: unknown,
): TodoThinkingOverrideRow[] {
  const rows = new Map<string, TodoThinkingOverrideRow>();
  for (const [pattern, level] of todoThinkingOverrideEntries(inheritedValue)) {
    rows.set(normalizePattern(pattern), {
      pattern,
      level,
      inherited: true,
      explicit: false,
    });
  }
  for (const [pattern, level] of todoThinkingOverrideEntries(explicitValue)) {
    const key = normalizePattern(pattern);
    rows.set(key, {
      pattern,
      level,
      inherited: rows.get(key)?.inherited ?? false,
      explicit: true,
    });
  }
  return [...rows.values()];
}

export function todoThinkingOverridePatternKey(pattern: string): string {
  return normalizePattern(pattern);
}

export function setTodoThinkingOverrideInSource(
  source: string,
  pattern: string,
  level: TodoThinkingOverrideValue,
): string {
  return updateSettingsSource(source, ["todoThinkingOverrides", pattern], level);
}

export function renameTodoThinkingOverrideInSource(
  source: string,
  row: TodoThinkingOverrideRow,
  pattern: string,
): string {
  const withoutPrevious = removeSettingsValue(source, ["todoThinkingOverrides", row.pattern]);
  return updateSettingsSource(withoutPrevious, ["todoThinkingOverrides", pattern], row.level);
}

export function removeTodoThinkingOverrideFromSource(
  source: string,
  row: TodoThinkingOverrideRow,
): string {
  return removeSettingsValue(source, ["todoThinkingOverrides", row.pattern]);
}

function todoThinkingOverrideEntries(value: unknown): Array<[string, TodoThinkingOverrideValue]> {
  if (!isRecord(value)) return [];
  const entries: Array<[string, TodoThinkingOverrideValue]> = [];
  for (const [rawPattern, level] of Object.entries(value)) {
    const pattern = rawPattern.trim();
    if (!pattern || (typeof level !== "string" && level !== null)) continue;
    entries.push([pattern, level]);
  }
  return entries;
}

function normalizePattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
