import {
  parseProjectIdentities,
  PROJECT_IDENTITIES_STORAGE_KEY,
  projectIdentityForPath,
  recordProjectIdentity,
  relocateDesktopStorage,
  serializeProjectIdentities,
} from "../lib/project-identity";
import { projectName } from "../lib/recent-projects";

/** `null` cancels the selection; otherwise open `target`, first moving state from `relocateFrom`. */
export type ProjectSelectionPlan = { target: string; relocateFrom?: string } | null;

export type RelocationReport = {
  movedSessions: number;
  conflicts: string[];
  skipped: string[];
  sessionMapUpdated?: number;
  tabSnapshotMoved: boolean;
};

type ProjectRelocationOptions = {
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  confirm: (message: string, options?: { title?: string; okLabel?: string }) => Promise<boolean>;
  pickFolder: (defaultPath: string) => Promise<string | null>;
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
  /** Moves in-memory path-keyed state owned by this window. */
  relocateInMemory: (from: string, to: string) => void;
  reportWarning: (message: string) => void;
  /** Recent project paths, used to find a renamed project without a stable ID. */
  recentProjects?: () => readonly string[];
};

/** Declined `from\u0000to` relocation offers, so the same prompt is not repeated. */
export const DECLINED_RELOCATIONS_STORAGE_KEY = "pix.desktop.declinedProjectRelocations";
const MAX_DECLINED = 50;

export function createProjectRelocation(options: ProjectRelocationOptions) {
  async function isDirectory(path: string): Promise<boolean> {
    return await options.invoke<string | null>("local_path_kind", { path }) === "directory";
  }

  function identities() {
    try { return parseProjectIdentities(options.storage().getItem(PROJECT_IDENTITIES_STORAGE_KEY)); }
    catch { return new Map<string, string>(); }
  }

  async function identity(path: string): Promise<string | null> {
    return await options.invoke<string | null>("project_identity", { workspace: path }) ?? null;
  }

  function declined(): string[] {
    try {
      const parsed: unknown = JSON.parse(options.storage().getItem(DECLINED_RELOCATIONS_STORAGE_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch { return []; }
  }

  function rememberDeclined(from: string, to: string): void {
    const key = `${from}\u0000${to}`;
    const next = [...declined().filter((entry) => entry !== key), key].slice(-MAX_DECLINED);
    try { options.storage().setItem(DECLINED_RELOCATIONS_STORAGE_KEY, JSON.stringify(next)); }
    catch (error) { options.reportWarning(`failed to remember declined relocation: ${String(error)}`); }
  }

  /** A missing recent project with the same folder name and no conflicting ID. */
  async function sameNameCandidate(selected: string, id: string | null): Promise<string | undefined> {
    const name = projectName(selected);
    const known = identities();
    const skipped = new Set(declined());
    const candidates: string[] = [];
    for (const path of options.recentProjects?.() ?? []) {
      if (path === selected || projectName(path) !== name) continue;
      if (skipped.has(`${path}\u0000${selected}`)) continue;
      const recordedId = projectIdentityForPath(known, path);
      if (recordedId && id && recordedId !== id) continue;
      if (await isDirectory(path)) continue;
      candidates.push(path);
    }
    // Ambiguous matches are not guessed; Locate Folder… remains available.
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  async function offerMove(previous: string, selected: string, reason: string): Promise<ProjectSelectionPlan> {
    const move = await options.confirm(
      `${reason} Move its sessions and Desktop state to this folder?`,
      { title: "Project folder moved", okLabel: "Move Sessions" },
    );
    if (move) return { target: selected, relocateFrom: previous };
    rememberDeclined(previous, selected);
    return { target: selected };
  }

  /** Detects a renamed/moved project before a switch. Never mutates project state. */
  async function plan(selected: string): Promise<ProjectSelectionPlan> {
    if (!await isDirectory(selected)) {
      const locate = await options.confirm(
        `The folder for “${projectName(selected)}” was not found at ${selected}. `
          + "If it was renamed or moved, choose its new location to keep its sessions.",
        { title: "Project folder not found", okLabel: "Locate Folder…" },
      );
      if (!locate) return null;
      const picked = await options.pickFolder(selected);
      if (!picked || picked === selected) return null;
      const expected = projectIdentityForPath(identities(), selected);
      const actual = await identity(picked).catch(() => null);
      if (expected && actual && expected !== actual && !await options.confirm(
        `${picked} is a different Pix project than ${selected}. Move the sessions there anyway?`,
        { title: "Different project", okLabel: "Move Anyway" },
      )) return null;
      return { target: picked, relocateFrom: selected };
    }
    const id = await identity(selected).catch(() => null);
    const previous = id ? identities().get(id) : undefined;
    if (previous && previous !== selected) {
      if (await isDirectory(previous) || declined().includes(`${previous}\u0000${selected}`)) return { target: selected };
      return offerMove(previous, selected, `This project was previously opened at ${previous}, which no longer exists.`);
    }
    if (previous === selected) return { target: selected };
    const candidate = await sameNameCandidate(selected, id);
    if (!candidate) return { target: selected };
    return offerMove(candidate, selected,
      `A project named “${projectName(selected)}” was previously opened at ${candidate}, which no longer exists.`);
  }

  /** Must run after the old workspace's sessions are closed. */
  async function relocate(from: string, to: string): Promise<RelocationReport> {
    const report = await options.invoke<RelocationReport>("relocate_project_state", { from, to });
    try { relocateDesktopStorage(options.storage(), from, to); }
    catch (error) { options.reportWarning(`project relocation storage update failed: ${String(error)}`); }
    options.relocateInMemory(from, to);
    if (report.conflicts.length > 0) {
      options.reportWarning(`project relocation left ${report.conflicts.length} conflicting entries at the old location: ${report.conflicts.join(", ")}`);
    }
    return report;
  }

  /** Remembers the opened folder's stable ID; best effort. */
  async function record(path: string): Promise<void> {
    const id = await identity(path);
    if (!id) return;
    const current = identities();
    const previous = current.get(id);
    if (previous === path) return;
    // A copy shares the ID; keep the still-existing original's mapping.
    if (previous && await isDirectory(previous)) return;
    options.storage().setItem(
      PROJECT_IDENTITIES_STORAGE_KEY,
      serializeProjectIdentities(recordProjectIdentity(current, id, path)),
    );
  }

  return { plan, relocate, record };
}

export type ProjectRelocation = ReturnType<typeof createProjectRelocation>;
