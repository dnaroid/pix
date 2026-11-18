/**
 * Desktop action for the project supervisor (decision 0077, phase 1): ask ACP
 * for the project's single supervisor session and show it as a tab. ACP owns
 * creation, deduplication and the supervisor-only tool; Desktop only opens it.
 */
type SupervisorClient = {
  openSupervisor(cwd: string): Promise<{ sessionId: string; created: boolean }>;
};

export type SupervisorSessionOptions<C extends SupervisorClient> = {
  client: () => C | null;
  workspace: () => string;
  refreshSessions: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  activateTab: (sessionId: string) => void;
  reportError: (error: unknown) => void;
};

export function createSupervisorSessionAction<C extends SupervisorClient>(options: SupervisorSessionOptions<C>) {
  let opening: Promise<void> | null = null;

  async function openOnce(): Promise<void> {
    const client = options.client();
    const workspace = options.workspace();
    if (!client || !workspace) return;
    const current = () => options.client() === client && options.workspace() === workspace;
    try {
      const { sessionId } = await client.openSupervisor(workspace);
      if (!current()) return;
      // A just-created session must be in the catalog before its tab is shown.
      await options.refreshSessions();
      if (!current()) return;
      await options.loadSession(sessionId);
      if (current()) options.activateTab(sessionId);
    } catch (error) {
      if (current()) options.reportError(error);
    }
  }

  /** Repeated clicks while opening join the running request. */
  function open(): Promise<void> {
    opening ??= openOnce().finally(() => { opening = null; });
    return opening;
  }

  return { open };
}
