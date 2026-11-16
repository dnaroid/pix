import {
  buildRecentProjects,
  parseRecentProjects,
  RECENT_PROJECTS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
} from "./recent-projects";

/** Stable project ID (`.pi/project-id`) -> last known absolute project path. */
export const PROJECT_IDENTITIES_STORAGE_KEY = "pix.desktop.projectIdentities";
const MODEL_FREQUENCY_PREFIX = "pix.desktop.modelSelectionFrequency.";
const WINDOW_LAYOUT_PREFIX = "pix.desktop.windowLayout.";
/** Window-layout preferences whose JSON object is keyed by workspace path. */
const WORKSPACE_KEYED_LAYOUTS = [".activeSessions", ".sessionTabs", ".sessionTabModels"];

export type ProjectIdentities = Map<string, string>;
type KeyedStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function parseProjectIdentities(serialized: string | null): ProjectIdentities {
  try {
    const parsed: unknown = JSON.parse(serialized ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).filter(
      (entry): entry is [string, string] => entry[0].length > 0 && typeof entry[1] === "string",
    ));
  } catch {
    return new Map();
  }
}

export function serializeProjectIdentities(identities: ReadonlyMap<string, string>): string {
  return JSON.stringify(Object.fromEntries(identities));
}

/** Records `id` at `path`; any other ID previously recorded for `path` is dropped. */
export function recordProjectIdentity(
  identities: ReadonlyMap<string, string>,
  id: string,
  path: string,
): ProjectIdentities {
  const next = new Map([...identities].filter(([key, value]) => key !== id && value !== path));
  next.set(id, path);
  return next;
}

export function projectIdentityForPath(
  identities: ReadonlyMap<string, string>,
  path: string,
): string | undefined {
  for (const [id, value] of identities) if (value === path) return id;
  return undefined;
}

/**
 * Moves Desktop-owned, path-keyed local state from `from` to `to`. Per-window
 * layout state from the old path replaces state created at `to` before relocation.
 */
export function relocateDesktopStorage(storage: KeyedStorage, from: string, to: string): void {
  const recent = parseRecentProjects(storage.getItem(RECENT_PROJECTS_STORAGE_KEY));
  if (recent.includes(from)) {
    const replaced = recent.map((path) => (path === from ? to : path));
    storage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(buildRecentProjects(replaced)));
  }
  if (storage.getItem(WORKSPACE_STORAGE_KEY) === from) storage.setItem(WORKSPACE_STORAGE_KEY, to);

  const identities = parseProjectIdentities(storage.getItem(PROJECT_IDENTITIES_STORAGE_KEY));
  if ([...identities.values()].includes(from)) {
    const targetTaken = [...identities.values()].includes(to);
    const next = new Map([...identities]
      .filter(([, path]) => !(targetTaken && path === from))
      .map(([id, path]) => [id, path === from ? to : path] as const));
    storage.setItem(PROJECT_IDENTITIES_STORAGE_KEY, serializeProjectIdentities(next));
  }

  const fromFrequency = `${MODEL_FREQUENCY_PREFIX}${encodeURIComponent(from)}`;
  const toFrequency = `${MODEL_FREQUENCY_PREFIX}${encodeURIComponent(to)}`;
  const frequency = storage.getItem(fromFrequency);
  if (frequency !== null) {
    if (storage.getItem(toFrequency) === null) storage.setItem(toFrequency, frequency);
    storage.removeItem(fromFrequency);
  }

  const layoutKeys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(WINDOW_LAYOUT_PREFIX) && WORKSPACE_KEYED_LAYOUTS.some((suffix) => key.endsWith(suffix))) {
      layoutKeys.push(key);
    }
  }
  for (const key of layoutKeys) {
    const relocated = relocateKeyedObject(storage.getItem(key), from, to);
    if (relocated !== undefined) storage.setItem(key, relocated);
  }
}

function relocateKeyedObject(serialized: string | null, from: string, to: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(serialized ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (!Object.hasOwn(record, from)) return undefined;
    // The old folder is gone, so its history wins over state just created at `to`.
    const next = { ...record, [to]: record[from] };
    delete next[from];
    return JSON.stringify(next);
  } catch {
    return undefined;
  }
}
