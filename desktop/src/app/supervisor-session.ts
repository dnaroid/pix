import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import { SvelteSet } from "svelte/reactivity";
import { supervisionActions, type SupervisionState } from "../lib/session-supervision";
import { sessionIsSupervisor, sessionSupervisedMode } from "../lib/session-tabs";
import { isSubagentSession } from "../lib/session-subagent-link";
import type { SupervisorCloseTabRequest, SupervisorCloseTabResponse } from "../../../acp/src/acp/supervisor-contract";

/** Matches `supervisor_menu::EVENT` in desktop/src-tauri/src/supervisor_menu.rs. */
export const SUPERVISOR_MENU_EVENT = "pix-open-supervisor";

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

type HandoverClient = {
  supervisorHandover(cwd: string, sessionId: string, supervised: boolean): Promise<{ supervised: boolean }>;
};

/**
 * `pix/supervisor/close_tab` (0077): after `close outcome=done` of a worker the
 * supervisor started, ACP asks Desktop to close that session's tab. Desktop
 * only closes the tab; the saved conversation stays for review and `reopen`.
 */
export type SupervisorTabAutoCloseOptions = {
  workspace: () => string;
  isTabOpen: (sessionId: string) => boolean;
  /** A running or otherwise busy session is left alone, never confirmed away. */
  isBusy: (sessionId: string) => boolean;
  closeTab: (sessionId: string) => Promise<boolean>;
};

export function createSupervisorTabAutoClose(options: SupervisorTabAutoCloseOptions) {
  return async (request: SupervisorCloseTabRequest): Promise<SupervisorCloseTabResponse> => {
    if (options.workspace() !== request.cwd) return { closed: false };
    if (!options.isTabOpen(request.sessionId) || options.isBusy(request.sessionId)) return { closed: false };
    try {
      return { closed: await options.closeTab(request.sessionId) };
    } catch {
      return { closed: false };
    }
  };
}

/**
 * Manual handover (0077): the user hands an ordinary conversation to the
 * project supervisor as `managed` or takes it back. ACP owns the
 * registry and ledger; Desktop only reflects the session-list marker.
 */
export function createSupervisorHandover<C extends HandoverClient>(options: {
  client: () => C | null;
  workspace: () => string;
  sessions: () => readonly SessionInfo[];
  refreshSessions: () => Promise<void>;
  reportError: (error: unknown) => void;
}) {
  const pending = new SvelteSet<string>();

  /** Undefined when the session can never be supervised (sub-agent, supervisor itself, unknown). */
  function supervision(sessionId: string): SupervisionState | undefined {
    const sessions = options.sessions();
    const session = sessions.find((item) => item.sessionId === sessionId);
    if (!session || isSubagentSession(session) || sessionIsSupervisor(session)) return undefined;
    return {
      mode: sessionSupervisedMode(session),
      supervisorAvailable: sessions.some(sessionIsSupervisor),
      enabled: !pending.has(sessionId) && Boolean(options.client() && options.workspace()),
    };
  }

  async function setSupervised(sessionId: string, supervised: boolean): Promise<void> {
    const client = options.client();
    const workspace = options.workspace();
    const current = supervision(sessionId);
    if (!client || !workspace || !current?.enabled || !supervisionActions(current).some((action) => action.supervised === supervised)) return;
    pending.add(sessionId);
    try {
      await client.supervisorHandover(workspace, sessionId, supervised);
      if (options.client() === client && options.workspace() === workspace) await options.refreshSessions();
    } catch (error) {
      if (options.client() === client && options.workspace() === workspace) options.reportError(error);
    } finally {
      pending.delete(sessionId);
    }
  }

  return { supervision, setSupervised };
}

type SupervisorMenuCommands = {
  enabled(id: "session.supervisor"): boolean;
  execute(id: "session.supervisor"): Promise<void>;
};

export const SUPERVISOR_MENU_UNAVAILABLE = "Open Project Supervisor is available once the project has finished loading.";

/**
 * The app-menu item runs the same command as the palette, with the same
 * availability rule. A click that arrives before Pix is ready (startup,
 * workspace switch, running session mutation) shows a notice instead of
 * being dropped silently.
 */
export async function handleSupervisorMenu(commands: SupervisorMenuCommands, notify: (message: string) => void): Promise<void> {
  if (!commands.enabled("session.supervisor")) {
    notify(SUPERVISOR_MENU_UNAVAILABLE);
    return;
  }
  await commands.execute("session.supervisor");
}

/**
 * Subscribe this window to the app-menu "Open Project Supervisor" item.
 * Returns the cleanup; a listener that resolves after teardown is released.
 */
export function listenSupervisorMenu(onOpen: () => void, report: (error: unknown) => void): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  getCurrentWebviewWindow().listen(SUPERVISOR_MENU_EVENT, () => { if (!disposed) onOpen(); })
    .then((stop) => { if (disposed) stop(); else unlisten = stop; })
    .catch(report);
  return () => { disposed = true; unlisten?.(); };
}
