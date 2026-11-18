import type { SupervisorMandatePatch, SupervisorMandateResponse } from "../../../acp/src/acp/supervisor-contract";

/** Live counters (running sessions, rework) change without a catalog event. */
export const MANDATE_POLL_MS = 5_000;

type MandateClient = {
  supervisorMandate(cwd: string, patch?: SupervisorMandatePatch): Promise<SupervisorMandateResponse>;
};

/**
 * Desktop view of the saved supervisor mandate (0077 "Mandate UI"). ACP owns
 * the mandate, clamping and ledger; Desktop only reads it with live counters
 * and sends user patches. Results that land after a client or project switch,
 * or behind a newer request, are dropped.
 */
export function createSupervisorMandate<C extends MandateClient>(options: {
  client: () => C | null;
  workspace: () => string;
  /** User-initiated changes: shown and logged. */
  reportError: (error: unknown) => void;
  /** Background reads: logged only. */
  reportWarning: (error: unknown) => void;
}) {
  let snapshot = $state.raw<{ workspace: string; mandate: SupervisorMandateResponse } | null>(null);
  let saving = $state(false);
  /** Open mandate form; `enable` pre-checks the enable box ("Set up"). */
  let editor = $state.raw<{ workspace: string; enable: boolean } | null>(null);
  let generation = 0;

  async function request(patch?: SupervisorMandatePatch): Promise<boolean> {
    const client = options.client();
    const workspace = options.workspace();
    if (!client || !workspace) return false;
    const id = ++generation;
    const sameTarget = () => options.client() === client && options.workspace() === workspace;
    try {
      const mandate = await client.supervisorMandate(workspace, patch);
      if (!sameTarget()) return false;
      if (id === generation) snapshot = { workspace, mandate };
      return true;
    } catch (error) {
      if (sameTarget()) (patch ? options.reportError : options.reportWarning)(error);
      return false;
    }
  }

  let reading: Promise<boolean> | null = null;
  /**
   * Background read. Joins a read in flight and is skipped while a change is
   * saving, so polling never piles up or overwrites the newer result.
   */
  function refresh(): Promise<boolean> {
    if (saving) return Promise.resolve(true);
    reading ??= request().finally(() => { reading = null; });
    return reading;
  }

  /** Poll while the supervisor session is visible; returns the cleanup. */
  function watch(intervalMs = MANDATE_POLL_MS): () => void {
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }

  async function update(patch: SupervisorMandatePatch): Promise<boolean> {
    if (saving || Object.keys(patch).length === 0) return false;
    saving = true;
    try {
      return await request(patch);
    } finally {
      saving = false;
    }
  }

  function openEditor(enable = false): void {
    const workspace = options.workspace();
    if (!editor && workspace && current()) editor = { workspace, enable };
  }
  function closeEditor(): void { editor = null; }
  function current(): SupervisorMandateResponse | null {
    return snapshot && snapshot.workspace === options.workspace() ? snapshot.mandate : null;
  }

  /** Save the form; it stays open (with the user's input) when the change fails. */
  async function save(draft: SupervisorMandateDraft): Promise<void> {
    const owner = editor;
    const mandate = current();
    if (!owner || !mandate) return;
    const patch = mandatePatch(mandate, draft);
    if (Object.keys(patch).length === 0 || await update(patch)) {
      if (editor === owner) editor = null;
    }
  }

  /** Drop a form left open across a project switch. */
  function reconcile(): void {
    if (editor && editor.workspace !== options.workspace()) editor = null;
  }

  return {
    /** Null until the current project's mandate has been read. */
    get mandate(): SupervisorMandateResponse | null { return current(); },
    get saving() { return saving; },
    get editor() { return editor && editor.workspace === options.workspace() ? editor : null; },
    refresh,
    watch,
    update,
    openEditor,
    closeEditor,
    save,
    reconcile,
  };
}

export type SupervisorMandateStore = ReturnType<typeof createSupervisorMandate>;

export type SupervisorMandateDraft = {
  enabled: boolean;
  maxConcurrent: number;
  maxReworkRounds: number;
  stalledAfterMinutes: number;
  workerModelRef: string;
  policy: string;
};

/** Only the fields the user changed, so the ledger records the real edit. */
export function mandatePatch(current: SupervisorMandateResponse, draft: SupervisorMandateDraft): SupervisorMandatePatch {
  const patch: SupervisorMandatePatch = {};
  if (draft.enabled !== current.enabled) patch.enabled = draft.enabled;
  for (const key of ["maxConcurrent", "maxReworkRounds", "stalledAfterMinutes"] as const) {
    if (draft[key] !== current[key]) patch[key] = draft[key];
  }
  if (draft.policy !== current.policy) patch.policy = draft.policy;
  if (draft.workerModelRef !== (current.workerModelRef ?? "")) {
    const workerModelRef = draft.workerModelRef.trim() || null;
    if (workerModelRef !== (current.workerModelRef ?? null)) patch.workerModelRef = workerModelRef;
  }
  return patch;
}
