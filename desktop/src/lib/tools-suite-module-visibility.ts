import { removeSettingsValue, settingsValue, updateSettingsSource } from "./settings.js";

export interface ToolsSuiteModuleCatalogEntry {
  readonly name: string;
  readonly defaultEnabled: boolean;
  readonly description: string;
}

export interface ToolsSuiteModuleState extends ToolsSuiteModuleCatalogEntry {
  readonly enabled: boolean;
}

const DISABLED_LIST_KEYS = ["disabledModules", "disabledExtensions"] as const;
const ENABLED_LIST_KEYS = ["enabledModules", "enabledExtensions"] as const;
const MODULE_MAP_KEYS = ["modules", "extensions"] as const;

export function toolsSuiteModuleStates(
  root: Record<string, unknown>,
  catalog: readonly ToolsSuiteModuleCatalogEntry[],
): ToolsSuiteModuleState[] {
  return catalog.map((entry) => ({ ...entry, enabled: toolsSuiteModuleEnabled(root, entry) }));
}

export function toolsSuiteUnknownModuleNames(
  root: Record<string, unknown>,
  catalog: readonly ToolsSuiteModuleCatalogEntry[],
): string[] {
  const known = new Set(catalog.map((entry) => entry.name));
  const names = new Set<string>();
  for (const key of [...DISABLED_LIST_KEYS, ...ENABLED_LIST_KEYS]) {
    for (const name of stringList(settingsValue(root, [key]))) {
      const normalized = name.toLowerCase();
      if (normalized !== "*" && normalized !== "all" && !known.has(normalized)) names.add(name);
    }
  }
  for (const key of MODULE_MAP_KEYS) {
    const value = settingsValue(root, [key]);
    if (!isRecord(value)) continue;
    for (const name of Object.keys(value)) if (!known.has(name.toLowerCase())) names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * Store a final per-module override in `modules`. This map is applied after
 * enabled/disabled lists, so it safely represents a checkbox choice. Remove a
 * same-name legacy `extensions` override because that map is applied last.
 */
export function updateToolsSuiteModuleSource(
  source: string,
  root: Record<string, unknown>,
  name: string,
  enabled: boolean,
): string {
  let next = updateSettingsSource(source, ["modules", name], enabled);
  const extensions = settingsValue(root, ["extensions"]);
  if (isRecord(extensions) && Object.prototype.hasOwnProperty.call(extensions, name)) {
    next = removeSettingsValue(next, ["extensions", name]);
  }
  return next;
}

function toolsSuiteModuleEnabled(
  root: Record<string, unknown>,
  entry: ToolsSuiteModuleCatalogEntry,
): boolean {
  let enabled = entry.defaultEnabled;
  const name = entry.name.toLowerCase();
  for (const key of DISABLED_LIST_KEYS) {
    const values = stringList(settingsValue(root, [key])).map((value) => value.toLowerCase());
    if (values.includes("*") || values.includes("all") || values.includes(name)) enabled = false;
  }
  for (const key of ENABLED_LIST_KEYS) {
    if (stringList(settingsValue(root, [key])).some((value) => value.toLowerCase() === name)) enabled = true;
  }
  for (const key of MODULE_MAP_KEYS) {
    const value = settingsValue(root, [key]);
    if (!isRecord(value)) continue;
    const exact = Object.entries(value).find(([moduleName]) => moduleName.toLowerCase() === name)?.[1];
    if (typeof exact === "boolean") enabled = exact;
  }
  return enabled;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
