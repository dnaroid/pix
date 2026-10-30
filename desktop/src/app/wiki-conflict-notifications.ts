import { isKnowledgeCheckResult, type KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import { readKnowledgeReport } from "../../../acp/src/knowledge/stamp";
import type { ProjectKnowledgeJob } from "./project-knowledge-queue.svelte";
import type { ToastInput } from "./toasts.svelte";

export const MAX_WIKI_CONFLICT_SIGNATURES = 2_048;
export const MAX_WIKI_CONFLICT_GROUPS = 8;
export const MAX_WIKI_CONFLICT_GROUP_PAGES = 1_024;
const MAX_PENDING_SIGNATURES = 32;

interface NotificationOptions {
  readonly workspace: () => string;
  readonly generation: () => number;
  readonly notify: (input: ToastInput) => void;
  readonly openPage: (path: string) => void | Promise<void>;
  readonly openChecks?: () => void | Promise<void>;
  /** Opens the Wiki Conflicts tab; a single page becomes its branch filter. */
  readonly openConflicts?: (input: { readonly path?: string }) => void | Promise<void>;
  readonly reportError?: (error: unknown) => void;
  readonly readReport?: typeof readKnowledgeReport;
}

interface Group { readonly paths: Set<string>; overflow: boolean; }
interface Owner {
  readonly workspace: string;
  readonly generation: number;
  readonly seen: Set<string>;
  readonly pending: Set<string>;
  readonly groups: Map<string, Group>;
}

/** Grounded claims identify a finding; a paraphrased explanation is not a new conflict. */
async function signature(result: KnowledgeCheckResult): Promise<string> {
  const findings = [...new Set(result.conflicts.map(finding => JSON.stringify([
    finding.draft.path, finding.draft.quote, finding.existing.path, finding.existing.quote,
  ])))].sort();
  const text = JSON.stringify([result.path, result.documentHash, findings]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function remember(owner: Owner, key: string): void {
  owner.seen.delete(key);
  owner.seen.add(key);
  while (owner.seen.size > MAX_WIKI_CONFLICT_SIGNATURES) owner.seen.delete(owner.seen.values().next().value!);
}

/** Notify only new grounded conflicts, without owning timers or retaining document bodies. */
export function createWikiConflictNotifications(options: NotificationOptions) {
  let owner: Owner | undefined;

  async function complete(job: ProjectKnowledgeJob): Promise<void> {
    if (job.state !== "completed" || !isKnowledgeCheckResult(job.result)
      || job.result.status !== "conflicts" || !job.result.conflicts.length
      || job.result.path !== job.path || !/^[0-9a-f]{64}$/u.test(job.result.documentHash)
      || job.workspace !== options.workspace()) return;
    const workspace = options.workspace(), generation = options.generation();
    const current = () => options.workspace() === workspace && options.generation() === generation;
    if (!owner || owner.workspace !== workspace || owner.generation !== generation) {
      owner = { workspace, generation, seen: new Set(), pending: new Set(), groups: new Map() };
    }
    const state = owner;
    let key: string | undefined;
    let reserved = false;
    try {
      key = await signature(job.result);
      if (!current() || state.seen.has(key) || state.pending.has(key)
        || state.pending.size >= MAX_PENDING_SIGNATURES) return;
      state.pending.add(key);
      reserved = true;
      const previous = await (options.readReport ?? readKnowledgeReport)(job.expectedContent);
      if (!current()) return;
      if (previous?.current && previous.result.status === "conflicts"
        && previous.result.path === job.path && previous.result.documentHash === job.result.documentHash) {
        const oldKey = await signature(previous.result);
        if (!current()) return;
        if (oldKey === key) { remember(state, key); return; }
      }
      if (!current()) return;
      remember(state, key);
      const pass = job.autoCheckRunId ?? "manual";
      let group = state.groups.get(pass);
      if (!group) {
        group = { paths: new Set(), overflow: false };
        state.groups.set(pass, group);
        while (state.groups.size > MAX_WIKI_CONFLICT_GROUPS) state.groups.delete(state.groups.keys().next().value!);
      }
      if (!group.paths.has(job.path)) {
        if (group.paths.size < MAX_WIKI_CONFLICT_GROUP_PAGES) group.paths.add(job.path);
        else group.overflow = true;
      }
      const count = String(group.paths.size) + (group.overflow ? "+" : "");
      const russian = job.result.reportLanguage === "ru";
      const multiple = group.paths.size > 1 || group.overflow;
      const actions: NonNullable<ToastInput["actions"]>[number][] = [];
      if (options.openConflicts) actions.push({
        label: russian ? "Разобрать" : "Review",
        run: async () => { if (current()) await options.openConflicts?.(multiple ? {} : { path: job.path }); },
      });
      actions.push({
        label: multiple
          ? russian ? "Последняя страница" : "Latest page"
          : russian ? "Открыть страницу" : "Open page",
        run: async () => { if (current()) await options.openPage(job.path); },
      });
      if (options.openChecks) actions.push({
        label: russian ? "Все проверки" : "All checks",
        run: async () => { if (current()) await options.openChecks?.(); },
      });
      options.notify({
        message: multiple
          ? russian ? "В Wiki найдены противоречия · страниц: " + count : "Wiki conflicts found · pages: " + count
          : russian ? "В Wiki найдены возможные противоречия" : "Potential Wiki contradictions found",
        detail: job.path,
        source: "Wiki",
        key: "wiki-conflicts:" + JSON.stringify([workspace, generation, pass]),
        log: false,
        durationMs: null,
        actions,
      });
    } catch (error) {
      if (current()) {
        try { options.reportError?.(error); } catch { /* Notification diagnostics cannot fail a check. */ }
      }
    } finally {
      if (reserved && key) state.pending.delete(key);
    }
  }

  return { complete };
}
