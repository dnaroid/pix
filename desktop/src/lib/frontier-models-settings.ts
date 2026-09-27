import {
  frontierOracleCandidates,
  modelVendor,
  normalizeFrontierModels,
  normalizedModelId,
  type FrontierConfig,
} from "../../../external/pi-tools-suite/src/async-subagents/core/frontier-models.js";

/**
 * Editable view of one `frontierModels` entry. The settings UI edits the
 * model, order, `expensive` and `enabled`; every other field (vendor,
 * aliases, roles, future keys) rides along untouched in `extra`.
 */
export interface FrontierModelRow {
  readonly model: string;
  readonly expensive: boolean;
  readonly enabled: boolean;
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface FrontierOraclePreview {
  /** Short id of the representative frontier parent for this vendor. */
  readonly parent: string;
  readonly vendor: string;
  /** Short ids of the oracle chain, in selection order. */
  readonly candidates: readonly string[];
}

export function frontierModelRows(value: unknown): FrontierModelRow[] {
  if (!Array.isArray(value)) return [];
  const rows: FrontierModelRow[] = [];
  for (const item of value) {
    const entry = typeof item === "string" ? { model: item } : item;
    if (!isRecord(entry) || typeof entry.model !== "string" || !entry.model.trim()) continue;
    const { model, expensive, enabled, ...extra } = entry;
    rows.push({
      model: model.trim(),
      expensive: expensive === true,
      enabled: enabled !== false,
      extra,
    });
  }
  return rows;
}

export function serializeFrontierModelRows(rows: readonly FrontierModelRow[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    model: row.model,
    ...row.extra,
    ...(row.expensive ? { expensive: true } : {}),
    ...(row.enabled ? {} : { enabled: false }),
  }));
}

export function moveFrontierModelRow(rows: readonly FrontierModelRow[], index: number, delta: -1 | 1): FrontierModelRow[] {
  const target = index + delta;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return [...rows];
  const next = [...rows];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function updateFrontierModelRow(
  rows: readonly FrontierModelRow[],
  index: number,
  patch: Partial<Pick<FrontierModelRow, "model" | "expensive" | "enabled">>,
): FrontierModelRow[] {
  return rows.map((row, rowIndex) => {
    if (rowIndex !== index) return row;
    if (patch.model === undefined || patch.model === row.model) return { ...row, ...patch };
    // Vendor and aliases identify the replaced model and would misclassify the
    // new one (e.g. Sol aliases on an Opus row). Roles describe the list slot.
    const { vendor: _vendor, aliases: _aliases, ...extra } = row.extra;
    return { ...row, ...patch, extra };
  });
}

export function removeFrontierModelRow(rows: readonly FrontierModelRow[], index: number): FrontierModelRow[] {
  return rows.filter((_row, rowIndex) => rowIndex !== index);
}

export function addFrontierModelRow(rows: readonly FrontierModelRow[], model: string): FrontierModelRow[] {
  const trimmed = model.trim();
  if (!trimmed || rows.some((row) => row.model === trimmed)) return [...rows];
  return [...rows, { model: trimmed, expensive: false, enabled: true, extra: {} }];
}

/** Compact read-only summary of the fields edited only in Advanced JSONC. */
export function frontierModelRowDetails(row: FrontierModelRow): string {
  const parts = [typeof row.extra.vendor === "string" ? row.extra.vendor : modelVendor(row.model) ?? "unknown vendor"];
  const roles = stringArray(row.extra.roles);
  if (roles.length > 0) parts.push(`only ${roles.join(", ")}`);
  const aliases = stringArray(row.extra.aliases);
  if (aliases.length > 0) parts.push(`aliases ${aliases.join(", ")}`);
  return parts.join(" · ");
}

/**
 * The oracle chain for one frontier parent of each configured vendor, using
 * the runtime's own selection rule. Runtime availability is not checked.
 */
export function frontierOraclePreview(rows: readonly FrontierModelRow[], economy: boolean): FrontierOraclePreview[] {
  // Normalize exactly as the runtime does so the preview matches spawn-time selection.
  const frontier: FrontierConfig = { models: normalizeFrontierModels(serializeFrontierModelRows(rows)) ?? [], economy };
  const seenVendors = new Set<string>();
  const previews: FrontierOraclePreview[] = [];
  for (const row of rows) {
    const vendor = modelVendor(row.model, frontier) ?? "unknown";
    if (seenVendors.has(vendor)) continue;
    seenVendors.add(vendor);
    previews.push({
      parent: shortModel(row.model),
      vendor,
      candidates: frontierOracleCandidates(row.model, frontier).map(shortModel),
    });
  }
  return previews;
}

function shortModel(ref: string): string {
  return normalizedModelId(ref) ?? ref;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
