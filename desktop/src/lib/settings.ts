import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC } from "../../../external/pi-tools-suite/src/default-pi-tools-suite-config.js";
import { DEFAULT_PIX_CONFIG_JSONC } from "../../../src/default-pix-config.js";

export type SettingsConfigKind = "pix" | "pi-tools-suite";

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

let editorCache: SettingsEditorCache = { activeKind: "pix", drafts: {} };

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

export type SettingsFieldKind = "boolean" | "number" | "string" | "select" | "string-list" | "json";

export interface SettingsSelectOption {
  readonly label: string;
  readonly value: unknown;
}

export interface SettingsField {
  readonly path: readonly string[];
  readonly label: string;
  readonly description?: string;
  readonly kind: SettingsFieldKind;
  readonly options?: readonly SettingsSelectOption[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly integer: boolean;
  readonly sensitive: boolean;
}

export interface SettingsSection {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly SettingsField[];
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
  pix: DEFAULT_PIX_CONFIG_JSONC,
  "pi-tools-suite": DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC,
};

// A few omission defaults are intentionally not materialized in the shipped
// JSONC template. Keep these small and limited to values whose runtime fallback
// is stable; schema/default and the canonical shipped config remain authoritative
// when they provide a value.
const SETTINGS_DEFAULT_OVERRIDES: Record<SettingsConfigKind, Record<string, unknown>> = {
  pix: {
    outputFilters: { patterns: [] },
  },
  "pi-tools-suite": {
    enabled: true,
    enabledModules: [],
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

export function settingsSections(schema: SettingsSchema): SettingsSection[] {
  const properties = schema.properties ?? {};
  const generalFields: SettingsField[] = [];
  const sections: SettingsSection[] = [];

  for (const [key, child] of Object.entries(properties)) {
    if (key === "$schema" || isForbiddenSchema(child)) continue;
    if (normalizedSchemaType(child) === "object" && child.properties) {
      const fields = collectFields(child, [key], []);
      if (fields.length > 0) {
        sections.push({ id: key, title: humanizeSettingKey(key), description: child.description, fields });
      }
    } else {
      generalFields.push(fieldFromSchema([key], child, humanizeSettingKey(key)));
    }
  }

  if (generalFields.length > 0) sections.unshift({ id: "general", title: "General", fields: generalFields });
  return sections;
}

function collectFields(
  schema: SettingsSchema,
  basePath: readonly string[],
  labelPath: readonly string[],
): SettingsField[] {
  const fields: SettingsField[] = [];
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (key === "$schema" || isForbiddenSchema(child)) continue;
    const path = [...basePath, key];
    const nextLabelPath = [...labelPath, humanizeSettingKey(key)];
    if (normalizedSchemaType(child) === "object" && child.properties) {
      fields.push(...collectFields(child, path, nextLabelPath));
    } else {
      fields.push(fieldFromSchema(path, child, nextLabelPath.join(" · ")));
    }
  }
  if (fields.length === 0 && basePath.length > 0) {
    fields.push(fieldFromSchema(basePath, schema, labelPath.at(-1) ?? "Configuration"));
  }
  return fields;
}

function fieldFromSchema(path: readonly string[], schema: SettingsSchema, label: string): SettingsField {
  const options = schemaConstOptions(schema);
  const type = normalizedSchemaType(schema);
  let kind: SettingsFieldKind;
  if (options.length > 0) kind = "select";
  else if (type === "boolean") kind = "boolean";
  else if (type === "number" || type === "integer") kind = "number";
  else if (type === "string") kind = "string";
  else if (type === "array" && normalizedSchemaType(schema.items) === "string") kind = "string-list";
  else kind = "json";
  return {
    path,
    label,
    description: schema.description,
    kind,
    ...(options.length > 0 ? { options } : {}),
    minimum: schema.minimum,
    maximum: schema.maximum,
    integer: type === "integer",
    sensitive: path.some((segment) => /(?:token|password|secret|api.?key)/iu.test(segment)),
  };
}

function schemaConstOptions(schema: SettingsSchema): SettingsSelectOption[] {
  const branches = schema.anyOf ?? [];
  if (branches.length === 0 || !branches.every((branch) => Object.prototype.hasOwnProperty.call(branch, "const"))) return [];
  return branches.map((branch) => ({ value: branch.const, label: branch.const === null ? "null" : String(branch.const) }));
}

function normalizedSchemaType(schema: SettingsSchema | undefined): string | undefined {
  if (!schema) return undefined;
  if (schema.type) return schema.type;
  const nonNull = (schema.anyOf ?? []).filter((branch) => branch.type !== "null");
  return nonNull.length === 1 ? normalizedSchemaType(nonNull[0]) : undefined;
}

function isForbiddenSchema(schema: SettingsSchema): boolean {
  return !!schema.not && Object.keys(schema.not).length === 0;
}

export function formatSettingsPath(path: readonly string[]): string {
  return path.join(".");
}

export function humanizeSettingKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[-_]+/gu, " ")
    .replace(/^./u, (character) => character.toUpperCase());
}

export function formatSettingValueForList(value: unknown): string {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : "";
}

export function parseSettingStringList(value: string): string[] {
  return value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

export function formatSettingJson(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
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
