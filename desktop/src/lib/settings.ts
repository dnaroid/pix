import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC } from "../../../external/pi-tools-suite/src/default-pi-tools-suite-config.js";
import {
  DEFAULT_DCP_CONFIG,
  DEFAULT_DCP_DEBUG_LOG_MAX_BACKUPS,
  DEFAULT_DCP_DEBUG_LOG_MAX_BYTES,
} from "../../../external/pi-tools-suite/src/dcp/defaults.js";
import { DEFAULT_DESKTOP_CONFIG_JSONC } from "./default-desktop-config";

export type SettingsConfigKind = "desktop" | "pi-tools-suite";

export interface SettingsConfigDocument {
  readonly path: string;
  readonly content: string;
  readonly exists: boolean;
  readonly schema: string;
}

export interface SettingsSchema {
  readonly type?: string;
  readonly description?: string;
  readonly const?: unknown;
  readonly default?: unknown;
  readonly anyOf?: readonly SettingsSchema[];
  readonly properties?: Readonly<Record<string, SettingsSchema>>;
  readonly patternProperties?: Readonly<Record<string, SettingsSchema>>;
  readonly items?: SettingsSchema;
  readonly required?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly additionalProperties?: boolean | SettingsSchema;
  readonly not?: SettingsSchema;
}

export interface SettingsDraftDocument extends SettingsConfigDocument {
  readonly source: string;
  readonly savedSource: string;
  readonly schemaObject: SettingsSchema;
}

export interface SettingsEditorCache {
  readonly activeKind: SettingsConfigKind;
  readonly drafts: Partial<Record<SettingsConfigKind, SettingsDraftDocument>>;
}

let editorCache: SettingsEditorCache = { activeKind: "desktop", drafts: {} };

export function settingsEditorCache(): SettingsEditorCache {
  return editorCache;
}

export function updateSettingsEditorCache(next: SettingsEditorCache): void {
  editorCache = next;
}

/**
 * Reconcile a completed save with the latest in-memory draft. A user can keep
 * typing while the IPC write is in flight; the returned document becomes the
 * new disk baseline without clobbering those newer edits.
 */
export function reconcileSavedSettingsDraft(
  latest: SettingsDraftDocument,
  submittedSource: string,
  saved: SettingsConfigDocument,
): SettingsDraftDocument {
  return {
    ...latest,
    ...saved,
    source: latest.source === submittedSource ? saved.content : latest.source,
    savedSource: saved.content,
  };
}

export interface ParsedSettingsSource {
  readonly value: Record<string, unknown>;
  readonly errors: readonly ParseError[];
}

export interface SettingsDefaultValue {
  readonly exists: boolean;
  readonly value?: unknown;
}

const SETTINGS_DEFAULT_SOURCES: Record<SettingsConfigKind, string> = {
  desktop: DEFAULT_DESKTOP_CONFIG_JSONC,
  "pi-tools-suite": DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC,
};

// A few omission defaults are intentionally not materialized in the shipped
// JSONC template. Keep these small and limited to values whose runtime fallback
// is stable; schema/default and the canonical shipped config remain authoritative
// when they provide a value.
const SETTINGS_DEFAULT_OVERRIDES: Record<SettingsConfigKind, Record<string, unknown>> = {
  desktop: {},
  "pi-tools-suite": {
    enabled: true,
    enabledModules: [],
  },
};

const PI_TOOLS_SUITE_DCP_RUNTIME_DEFAULTS: Record<string, unknown> = {
  ...DEFAULT_DCP_CONFIG,
  debugLog: {
    maxBytes: DEFAULT_DCP_DEBUG_LOG_MAX_BYTES,
    maxBackups: DEFAULT_DCP_DEBUG_LOG_MAX_BACKUPS,
  },
};

let parsedDefaultRoots: Partial<Record<SettingsConfigKind, Record<string, unknown>>> = {};

export function parseSettingsSource(source: string): ParsedSettingsSource {
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  return { value: isRecord(parsed) ? parsed : {}, errors };
}

export function parseSettingsSchema(source: string): SettingsSchema {
  const parsed = JSON.parse(source) as unknown;
  if (!isRecord(parsed)) throw new Error("Settings schema must be an object");
  return parsed as SettingsSchema;
}

export function settingsValue(root: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

export function settingsHasValue(root: Record<string, unknown>, path: readonly string[]): boolean {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

export function settingsDefaultValue(
  kind: SettingsConfigKind,
  schema: SettingsSchema,
  path: readonly string[],
): SettingsDefaultValue {
  const fieldSchema = settingsSchemaAtPath(schema, path);
  if (fieldSchema && Object.prototype.hasOwnProperty.call(fieldSchema, "default")) {
    return { exists: true, value: fieldSchema.default };
  }

  if (kind === "pi-tools-suite" && path[0] === "dcp") {
    const dcpPath = path.slice(1);
    if (settingsHasValue(PI_TOOLS_SUITE_DCP_RUNTIME_DEFAULTS, dcpPath)) {
      return { exists: true, value: settingsValue(PI_TOOLS_SUITE_DCP_RUNTIME_DEFAULTS, dcpPath) };
    }
    return { exists: false };
  }

  const defaults = settingsDefaultRoot(kind);
  if (settingsHasValue(defaults, path)) return { exists: true, value: settingsValue(defaults, path) };

  const overrides = SETTINGS_DEFAULT_OVERRIDES[kind];
  if (settingsHasValue(overrides, path)) return { exists: true, value: settingsValue(overrides, path) };
  return { exists: false };
}

function settingsDefaultRoot(kind: SettingsConfigKind): Record<string, unknown> {
  const cached = parsedDefaultRoots[kind];
  if (cached) return cached;
  const parsed = parseSettingsSource(SETTINGS_DEFAULT_SOURCES[kind]);
  parsedDefaultRoots = { ...parsedDefaultRoots, [kind]: parsed.value };
  return parsed.value;
}

function settingsSchemaAtPath(schema: SettingsSchema, path: readonly string[]): SettingsSchema | undefined {
  let current: SettingsSchema | undefined = schema;
  for (const segment of path) {
    current = current?.properties?.[segment];
    if (!current) return undefined;
  }
  return current;
}

export function updateSettingsSource(source: string, path: readonly string[], value: unknown): string {
  const edits = modify(source, [...path], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  return applyEdits(source, edits);
}

export function removeSettingsValue(source: string, path: readonly string[]): string {
  return updateSettingsSource(source, path, undefined);
}

export function formatSettingsDefaultValue(value: unknown): string {
  if (typeof value === "string") return value || '""';
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length <= 2 && value.every((item) => typeof item === "string")) return value.join(", ");
    return `[${value.length} items]`;
  }
  if (isRecord(value)) return Object.keys(value).length === 0 ? "{}" : `{${Object.keys(value).length} keys}`;
  return "unset";
}

export function settingsSourceIssues(source: string, schema: SettingsSchema): string[] {
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0) return errors.map((error) => `JSONC parse error at offset ${error.offset}`);
  if (!isRecord(parsed)) return ["Config root must be a JSON object"];
  return validateSettingsValue(parsed, schema, "$", 20);
}

function validateSettingsValue(
  value: unknown,
  schema: SettingsSchema,
  location: string,
  limit: number,
): string[] {
  if (limit <= 0) return [];
  if (schema.not && Object.keys(schema.not).length === 0) return [`${location} is a removed setting`];
  if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) {
    return [`${location} must be ${String(schema.const)}`];
  }
  if (schema.anyOf?.length) {
    if (schema.anyOf.some((branch) => validateSettingsValue(value, branch, location, limit).length === 0)) return [];
    return [`${location} does not match any allowed value or type`];
  }

  if (schema.type === "object") {
    if (!isRecord(value)) return [`${location} must be an object`];
    const issues: string[] = [];
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) issues.push(`${location}.${required} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      issues.push(...validateSettingsValue(value[key], child, `${location}.${key}`, limit - issues.length));
      if (issues.length >= limit) return issues.slice(0, limit);
    }
    const patterns = Object.entries(schema.patternProperties ?? {}).map(([pattern, child]) => [new RegExp(pattern), child] as const);
    for (const [key, childValue] of Object.entries(value)) {
      if (schema.properties?.[key]) continue;
      for (const [pattern, child] of patterns) {
        if (pattern.test(key)) issues.push(...validateSettingsValue(childValue, child, `${location}.${key}`, limit - issues.length));
      }
      if (issues.length >= limit) return issues.slice(0, limit);
    }
    return issues;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${location} must be an array`];
    if (!schema.items) return [];
    const issues: string[] = [];
    value.forEach((item, index) => {
      if (issues.length < limit) issues.push(...validateSettingsValue(item, schema.items!, `${location}[${index}]`, limit - issues.length));
    });
    return issues.slice(0, limit);
  }
  if (schema.type === "string" && typeof value !== "string") return [`${location} must be a string`];
  if (schema.type === "boolean" && typeof value !== "boolean") return [`${location} must be a boolean`];
  if ((schema.type === "number" || schema.type === "integer") && (typeof value !== "number" || !Number.isFinite(value))) {
    return [`${location} must be a number`];
  }
  if (schema.type === "integer" && typeof value === "number" && !Number.isInteger(value)) return [`${location} must be an integer`];
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return [`${location} must be >= ${schema.minimum}`];
    if (schema.maximum !== undefined && value > schema.maximum) return [`${location} must be <= ${schema.maximum}`];
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
