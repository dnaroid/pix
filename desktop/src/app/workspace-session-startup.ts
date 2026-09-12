import type { AcpClient } from "../lib/acp-client";
import { emptyTranscript } from "../lib/transcript";
import { startupSessionId } from "../lib/session-tabs";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { createDraftSession } from "./draft-session.svelte";
import type { createSessionCatalog } from "./session-catalog.svelte";
import type { createSessionHistory } from "./session-history.svelte";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";
import type { createSessionTabsState } from "./session-tabs-state.svelte";

type DraftSession = ReturnType<typeof createDraftSession>;
type SessionCatalog = ReturnType<typeof createSessionCatalog>;
type SessionHistory = ReturnType<typeof createSessionHistory>;
type SessionRuntime = ReturnType<typeof createSessionRuntimeStore>;
type SessionTabs = ReturnType<typeof createSessionTabsState>;

type WorkspaceSessionStartupOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  catalog: SessionCatalog;
  tabs: SessionTabs;
  draft: DraftSession;
  runtime: SessionRuntime;
  history: SessionHistory;
  state: ActiveSessionState;
  setOperationRunning: (running: boolean) => void;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createWorkspaceSessionStartup(options: WorkspaceSessionStartupOptions) {
  async function open(): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace) return;

    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      const response = await options.catalog.listNow();
      if (!response || options.client() !== requestClient || options.workspace() !== requestWorkspace) return;

      const desktopSessionId = options.tabs.activeForProject(requestWorkspace);
      const sessionId = startupSessionId(response, desktopSessionId);
      if (desktopSessionId && desktopSessionId !== sessionId) options.tabs.forgetActive(requestWorkspace);

      options.state.resetConversation();
      if (!sessionId) {
        options.draft.activate({ resetComposer: true });
        return;
      }

      options.draft.close();
      options.state.setSessionId(sessionId);
      options.state.setConfigOptions(options.runtime.getConfigOptions(sessionId) ?? []);
      options.state.setRuntimeReady(options.runtime.isReady(sessionId));
      const historyGeneration = options.history.begin();
      void options.history.hydrate(requestClient, sessionId, requestWorkspace, historyGeneration);
      options.tabs.show(sessionId);
      options.tabs.rememberActive(requestWorkspace, sessionId);

      const runtime = options.runtime.ensure(requestClient, sessionId, requestWorkspace);
      void runtime.then(() => {
        if (!options.runtime.isReady(sessionId)) return;
        options.runtime.schedulePrewarm(
          requestClient,
          requestWorkspace,
          options.tabs.restoredIds ?? response.sessions.map((session) => session.sessionId),
        );
      });
    } catch (error) {
      if (options.client() !== requestClient || options.workspace() !== requestWorkspace) return;
      options.history.cancel();
      options.state.setSessionId(null);
      options.state.setTranscript(emptyTranscript);
      options.reportError(error);
    } finally {
      if (options.client() === requestClient && options.workspace() === requestWorkspace) {
        options.setOperationRunning(false);
      }
    }
  }

  return { open };
}
