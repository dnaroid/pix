import { SvelteMap } from "svelte/reactivity";
import type { SubagentSessionState } from "../lib/session-subagent-link";
import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";

type SubagentNavigationOptions = Pick<DesktopViewModelServicesOptions,
  "workspace" | "state" | "client" | "sessions" | "transitions" | "errors"
>;

/**
 * Read-only sub-agent session tabs: open a viewer for an agent of the active
 * session, return to its parent, or continue it in a new ordinary session.
 * Navigation errors are reported here; callers may fire and forget.
 */
export function createSubagentSessionNavigation(options: SubagentNavigationOptions) {
  /** Last persisted revision rendered per viewer; bounded by open viewers. */
  const renderedRevisions = new Map<string, string>();
  /** Last display state per viewer (model/context for the status bar); bounded. */
  const viewerStates = new SvelteMap<string, SubagentSessionState>();
  const MAX_VIEWER_STATES = 32;

  function rememberState(sessionId: string, state: SubagentSessionState): void {
    const previous = viewerStates.get(sessionId);
    if (previous && JSON.stringify(previous) === JSON.stringify(state)) return;
    viewerStates.delete(sessionId);
    viewerStates.set(sessionId, state);
    while (viewerStates.size > MAX_VIEWER_STATES) viewerStates.delete(viewerStates.keys().next().value!);
  }

  /** Refresh the catalog and select `sessionId` unless the context moved on. */
  async function select(sessionId: string, unavailable: string): Promise<void> {
    const workspace = options.workspace();
    const client = options.client();
    await options.sessions.catalog.refresh();
    if (workspace !== options.workspace() || client !== options.client()) return;
    if (options.sessions.catalog.sessions.some((session) => session.sessionId === sessionId)) {
      await options.transitions.sessionTabs.loadSession(sessionId);
    } else options.errors.report(new Error(unavailable));
  }

  async function openSubagentSession(runDir: string, agentId: string): Promise<void> {
    try {
      const client = options.client();
      const parentSessionId = options.state.sessionId;
      if (!client || !parentSessionId) return;
      const opened = await client.openSubagentSession(parentSessionId, runDir, agentId);
      if (client !== options.client()) return;
      const { sessionId: _sessionId, link: _link, ...state } = opened;
      rememberState(opened.sessionId, state);
      await select(opened.sessionId, "This sub-agent session is no longer available.");
    } catch (error) {
      options.errors.report(error);
    }
  }

  async function openParentSession(parentSessionId: string): Promise<void> {
    try {
      await select(parentSessionId, "The parent session is no longer available.");
    } catch (error) {
      options.errors.report(error);
    }
  }

  async function continueSubagentSession(viewerSessionId: string): Promise<void> {
    try {
      const client = options.client();
      if (!client) return;
      const sessionId = await client.forkSubagentSession(viewerSessionId);
      if (client !== options.client()) return;
      await select(sessionId, "The continued session is no longer available.");
    } catch (error) {
      options.errors.report(error);
    }
  }

  /**
   * Poll the active viewer; re-read persisted history when the JSONL changed.
   * Returns undefined when polling should stop (tab switched, client gone, error).
   */
  async function pollViewer(sessionId: string): Promise<SubagentSessionState | undefined> {
    const client = options.client();
    const workspace = options.workspace();
    if (!client || options.state.sessionId !== sessionId) return undefined;
    try {
      const state = await client.subagentSessionState(sessionId);
      if (client !== options.client() || workspace !== options.workspace() || options.state.sessionId !== sessionId) return undefined;
      if (renderedRevisions.get(sessionId) !== state.revision
        && await options.sessions.history.refreshViewer(client, sessionId, workspace)) {
        renderedRevisions.set(sessionId, state.revision);
      }
      if (state.terminal) renderedRevisions.delete(sessionId);
      rememberState(sessionId, state);
      return state;
    } catch (error) {
      renderedRevisions.delete(sessionId);
      if (client === options.client() && options.state.sessionId === sessionId) options.errors.report(error);
      return undefined;
    }
  }

  function forgetViewer(sessionId: string): void {
    renderedRevisions.delete(sessionId);
    viewerStates.delete(sessionId);
  }

  function viewerState(sessionId: string): SubagentSessionState | undefined {
    return viewerStates.get(sessionId);
  }

  return { openSubagentSession, openParentSession, continueSubagentSession, pollViewer, forgetViewer, viewerState };
}

export type SubagentSessionNavigation = ReturnType<typeof createSubagentSessionNavigation>;
