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
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
  /** Reports whether initial workspace session restoration is in flight. */
  onOpeningChange?: (opening: boolean) => void;
  /** Composer contents, used to detect user input while the listing is pending. */
  promptText?: () => string;
  promptAttachments?: () => readonly unknown[];
};

type SelectionSnapshot = {
  sessionId: string | null;
  draftOpen: boolean;
  draftActive: boolean;
  promptText: string | undefined;
  promptAttachmentCount: number | undefined;
};

export function createWorkspaceSessionStartup(options: WorkspaceSessionStartupOptions) {
  let opening: {
    client: AcpClient;
    workspace: string;
    promise: Promise<void>;
  } | null = null;

  function open(): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace) return Promise.resolve();
    const activeOpening = opening;
    if (
      activeOpening
      && activeOpening.client === requestClient
      && activeOpening.workspace === requestWorkspace
    ) {
      return activeOpening.promise;
    }
    const pending = openNow(requestClient, requestWorkspace).finally(() => {
      if (opening?.promise !== pending) return;
      opening = null;
      options.onOpeningChange?.(false);
    });
    opening = { client: requestClient, workspace: requestWorkspace, promise: pending };
    options.onOpeningChange?.(true);
    return pending;
  }

  function snapshotSelection(): SelectionSnapshot {
    return {
      sessionId: options.state.sessionId,
      draftOpen: options.draft.open,
      draftActive: options.draft.active,
      promptText: options.promptText?.(),
      promptAttachmentCount: options.promptAttachments?.().length,
    };
  }

  function selectionChanged(before: SelectionSnapshot): boolean {
    const after = snapshotSelection();
    return before.sessionId !== after.sessionId
      || before.draftOpen !== after.draftOpen
      || before.draftActive !== after.draftActive
      || before.promptText !== after.promptText
      || before.promptAttachmentCount !== after.promptAttachmentCount;
  }

  async function openNow(requestClient: AcpClient, requestWorkspace: string): Promise<void> {
    options.setErrorMessage(null);
    try {
      const desktopTabSessionIds = options.tabs.sessionTabsForProject(requestWorkspace);
      const selection = snapshotSelection();
      const response = await options.catalog.listNow();
      if (!response || options.client() !== requestClient || options.workspace() !== requestWorkspace) return;
      // Tabs and the draft stay interactive while the workspace opens. A tab the
      // user picked or text typed meanwhile wins over the restored selection.
      if (selectionChanged(selection)) return;

      const desktopSessionId = options.tabs.activeForProject(requestWorkspace);
      const sessionId = startupSessionId(response, desktopSessionId, desktopTabSessionIds);
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
    }
  }

  return { open };
}
