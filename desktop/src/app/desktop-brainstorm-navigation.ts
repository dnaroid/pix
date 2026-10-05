import type { DesktopViewModelServicesOptions } from "./desktop-view-model-service-options";

/** Reuse catalog-backed session navigation from both transcript and council popup. */
export function createBrainstormSessionOpener(options: Pick<DesktopViewModelServicesOptions,
  "workspace" | "state" | "client" | "sessions" | "transitions" | "errors"
>) {
  return async function openBrainstormSession(sessionId: string): Promise<void> {
    const workspace = options.workspace();
    const activeSessionId = options.state.sessionId;
    const client = options.client();
    await options.sessions.catalog.refresh();
    if (workspace !== options.workspace() || activeSessionId !== options.state.sessionId || client !== options.client()) return;
    if (options.sessions.catalog.sessions.some((session) => session.sessionId === sessionId)) {
      await options.transitions.sessionTabs.loadSession(sessionId);
    } else options.errors.report(new Error("This brainstorm session is no longer available."));
  };
}
