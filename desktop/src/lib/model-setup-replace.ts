/**
 * Pure helpers for the model setup "In use" page: list every configured model,
 * replace one everywhere (primary slots, fallback lists, frontier list) and
 * suggest newer releases of the same model line.
 */

export type SetupRole = "main" | "fast" | "strong";

export interface UsageSlot {
  readonly id: string;
  readonly label: string;
  readonly role: SetupRole;
  readonly optional?: boolean;
  readonly list?: boolean;
  readonly parent?: string;
  readonly thinking?: boolean;
}

export interface SetupDraft {
  readonly roles: Readonly<Record<SetupRole, string>>;
  /** Per-slot primary picks; absent = follows its role (optional slots: unset). */
  readonly picks: Readonly<Record<string, string>>;
  /** Fully resolved list slots (fallbacks, extra frontier models). */
  readonly lists: Readonly<Record<string, readonly string[]>>;
  /** Thinking level per slot id; "" = model default. */
  readonly thinking: Readonly<Record<string, string>>;
}

export const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const slotRef = (slot: UsageSlot, draft: SetupDraft): string =>
  draft.picks[slot.id] ?? (slot.optional ? "" : draft.roles[slot.role]);

/** Every configured model with the slots using it, most used first. */
export function modelUsage(slots: readonly UsageSlot[], draft: SetupDraft): { ref: string; slots: UsageSlot[] }[] {
  const usage = new Map<string, UsageSlot[]>();
  const add = (ref: string, slot: UsageSlot) => {
    if (ref) usage.set(ref, [...(usage.get(ref) ?? []), slot]);
  };
  for (const slot of slots) {
    if (slot.list) for (const ref of draft.lists[slot.id] ?? []) add(ref, slot);
    else add(slotRef(slot, draft), slot);
  }
  return [...usage.entries()].map(([ref, users]) => ({ ref, slots: users })).sort((a, b) => b.slots.length - a.slots.length);
}

/** Nearest supported level (ties go lower); unknown support keeps the level. */
export function clampThinking(level: string, supported: readonly string[] | undefined): string {
  if (!level || !supported || supported.length === 0 || supported.includes(level)) return level;
  const at = THINKING_ORDER.indexOf(level as (typeof THINKING_ORDER)[number]);
  if (at < 0) return level;
  let best = "";
  let bestDistance = Infinity;
  for (const candidate of supported) {
    const index = THINKING_ORDER.indexOf(candidate as (typeof THINKING_ORDER)[number]);
    if (index < 0) continue;
    const distance = Math.abs(index - at);
    if (distance < bestDistance || (distance === bestDistance && index < at)) { best = candidate; bestDistance = distance; }
  }
  return best || level;
}

export interface ReplaceOptions {
  /** Supported thinking levels of a model, when known. */
  readonly levelsOf?: (ref: string) => readonly string[] | undefined;
  /** Whether a model satisfies a slot's constraints (vision, provider). */
  readonly fits?: (slot: UsageSlot, ref: string) => boolean;
  /** Human-readable slot name for notes. */
  readonly labelOf?: (slot: UsageSlot) => string;
}

export function replaceModel(slots: readonly UsageSlot[], draft: SetupDraft, from: string, to: string, options: ReplaceOptions = {}): { draft: SetupDraft; notes: string[] } {
  const notes: string[] = [];
  if (!from || !to || from === to) return { draft, notes };
  const name = options.labelOf ?? ((slot: UsageSlot) => slot.label);
  const fits = (slot: UsageSlot) => options.fits?.(slot, to) ?? true;
  const before = new Map(slots.filter((s) => !s.list).map((s) => [s.id, slotRef(s, draft)]));
  const roles = { ...draft.roles };
  const picks: Record<string, string> = { ...draft.picks };
  for (const role of Object.keys(roles) as SetupRole[]) {
    if (roles[role] !== from) continue;
    roles[role] = to;
    // Slots following this role that cannot take the new model keep the old one explicitly.
    for (const slot of slots) {
      if (!slot.list && !slot.optional && slot.role === role && picks[slot.id] === undefined && !fits(slot)) {
        picks[slot.id] = from;
        notes.push(`Kept for ${name(slot)}: the new model does not fit this slot.`);
      }
    }
  }
  for (const slot of slots) {
    if (slot.list || picks[slot.id] !== from || before.get(slot.id) !== from) continue;
    if (fits(slot)) picks[slot.id] = to;
    else if (!notes.some((n) => n.endsWith(`${name(slot)}: the new model does not fit this slot.`))) notes.push(`Kept for ${name(slot)}: the new model does not fit this slot.`);
  }
  const next: SetupDraft = { roles, picks, lists: draft.lists, thinking: draft.thinking };
  const lists: Record<string, readonly string[]> = { ...draft.lists };
  for (const slot of slots) {
    const list = draft.lists[slot.id];
    if (!slot.list || !list?.includes(from)) continue;
    if (!fits(slot)) { notes.push(`Kept in ${name(slot)}: the new model does not fit this list.`); continue; }
    const parent = slots.find((s) => s.id === slot.parent);
    const primary = parent ? slotRef(parent, next) : "";
    lists[slot.id] = [...new Set(list.map((ref) => (ref === from ? to : ref)))].filter((ref) => ref !== primary);
  }
  const thinking: Record<string, string> = { ...draft.thinking };
  const levels = options.levelsOf?.(to);
  for (const slot of slots) {
    if (slot.list || !slot.thinking || before.get(slot.id) !== from || slotRef(slot, next) !== to) continue;
    const level = thinking[slot.id] ?? "";
    const clamped = clampThinking(level, levels);
    if (clamped !== level) {
      thinking[slot.id] = clamped;
      notes.push(`${name(slot)}: thinking ${level} → ${clamped} (not supported by the new model).`);
    }
  }
  return { draft: { roles, picks, lists, thinking }, notes };
}

/** Makes `ref` the primary frontier model; the previous primary stays in the frontier list. */
export function promoteFrontier(slots: readonly UsageSlot[], draft: SetupDraft, ref: string, primaryId = "frontier-primary", extraId = "frontier-extra"): SetupDraft {
  const primary = slots.find((s) => s.id === primaryId);
  if (!primary || !ref) return draft;
  const previous = slotRef(primary, draft);
  if (previous === ref) return draft;
  const extra = [previous, ...(draft.lists[extraId] ?? [])].filter((m) => m && m !== ref);
  return { ...draft, picks: { ...draft.picks, [primaryId]: ref }, lists: { ...draft.lists, [extraId]: [...new Set(extra)] } };
}

interface ParsedModel { readonly provider: string; readonly family: string; readonly version: readonly number[] }

function parseModel(ref: string): ParsedModel | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0) return undefined;
  const id = ref.slice(slash + 1).toLowerCase().replace(/[-_.]?\d{6,}/gu, "");
  const version = [...id.matchAll(/\d+(?:[.-]\d+)*/gu)].flatMap((m) => m[0].split(/[.-]/u).map(Number));
  if (version.length === 0) return undefined;
  const family = id.replace(/\d+(?:[.-]\d+)*/gu, "#");
  return /[a-z]/u.test(family) ? { provider: ref.slice(0, slash), family, version } : undefined;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Newest model of the same provider and line with a higher version, if any (heuristic hint only). */
export function upgradeCandidate(ref: string, available: readonly string[]): string | undefined {
  const current = parseModel(ref);
  if (!current) return undefined;
  let best: { ref: string; version: readonly number[] } | undefined;
  for (const candidate of available) {
    if (candidate === ref) continue;
    const parsed = parseModel(candidate);
    if (!parsed || parsed.provider !== current.provider || parsed.family !== current.family) continue;
    if (compareVersions(parsed.version, current.version) <= 0) continue;
    if (!best || compareVersions(parsed.version, best.version) > 0) best = { ref: candidate, version: parsed.version };
  }
  return best?.ref;
}
