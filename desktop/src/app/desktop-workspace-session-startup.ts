import type { AcpClient } from "../lib/acp-client";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { DesktopSessionServices } from "./desktop-session-services";
import type { createDraftSession } from "./draft-session.svelte";
import { createWorkspaceSessionStartup } from "./workspace-session-startup";

type DraftSession = ReturnType<typeof createDraftSession>;

type DesktopWorkspaceSessionStartupOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  sessions: DesktopSessionServices;
  draft: DraftSession;
  state: ActiveSessionState;
  setOperationRunning: (running: boolean) => void;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createDesktopWorkspaceSessionStartup(options: DesktopWorkspaceSessionStartupOptions) {
  return createWorkspaceSessionStartup({
    client: options.client,
    workspace: options.workspace,
    catalog: options.sessions.catalog,
    tabs: options.sessions.tabs,
    draft: options.draft,
    runtime: options.sessions.runtime,
    history: options.sessions.history,
    state: options.state,
    setOperationRunning: options.setOperationRunning,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
  });
}

export type DesktopWorkspaceSessionStartup = ReturnType<typeof createDesktopWorkspaceSessionStartup>;
