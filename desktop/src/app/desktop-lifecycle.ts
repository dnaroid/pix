import { installDesktopFileDrop } from "../lib/desktop-file-drop";

const RUNTIME_STATUS_REFRESH_MS = 5 * 60_000;

type DesktopLifecycleOptions = {
  activeSessionId: () => string | null;
  activeSessionRuntimeReady: () => boolean;
  refreshRuntimeStatus: (sessionId: string, force?: boolean) => void | Promise<void>;
  disposeGitCi: () => void;
  disposeProjectDocuments?: () => void;
  restoreProjects: () => void;
  refreshProjectColors: () => void;
  workspace: () => string;
  loadWorkspaceData: (workspace: string) => void;
  canAcceptDroppedAttachments: () => boolean;
  setDragActive: (active: boolean) => void;
  activeCustomQuestionId: () => string | null;
  addQuestionImagePaths: (questionId: string, paths: readonly string[]) => void | Promise<void>;
  canInsertPromptAttachments: () => boolean;
  insertPromptPaths: (paths: readonly string[]) => void | Promise<void>;
  connect: () => Promise<void>;
  disposeConnection: () => void | Promise<void>;
  /**
   * connection.dispose() does not fire onDisconnect, so teardown must release
   * runtime state (quota/credential retry timers, btw, activity) explicitly.
   */
  resetAfterDisconnect: () => void;
  disposeSessionUpdates: () => void;
  disposeTranscriptScroll: () => void;
  cancelAllPendingElicitations: () => void;
  reportError: (error: unknown) => void;
};

export function createDesktopLifecycle(options: DesktopLifecycleOptions) {
  function start(): () => void {
    let disposed = false;
    const runtimeStatusTimer = window.setInterval(() => {
      const sessionId = options.activeSessionId();
      if (sessionId && options.activeSessionRuntimeReady()) {
        void options.refreshRuntimeStatus(sessionId, true);
      }
    }, RUNTIME_STATUS_REFRESH_MS);

    options.restoreProjects();
    options.refreshProjectColors();
    const workspace = options.workspace();
    if (workspace) {
      options.loadWorkspaceData(workspace);
    }

    const disposeFileDrop = installDesktopFileDrop({
      workspace: options.workspace,
      sessionId: options.activeSessionId,
      canAcceptAttachments: options.canAcceptDroppedAttachments,
      setDragActive: options.setDragActive,
      questionId: options.activeCustomQuestionId,
      addQuestionPaths: options.addQuestionImagePaths,
      canInsertPromptPaths: options.canInsertPromptAttachments,
      insertPromptPaths: options.insertPromptPaths,
      reportError: options.reportError,
    });

    function disposeConnectionAndReset(): void {
      // Reset now, and again once in-flight connection work has settled so a
      // completion racing teardown cannot leave timers or state behind.
      let pending: void | Promise<void>;
      try {
        pending = options.disposeConnection();
      } finally {
        resetAfterDisconnect();
      }
      void Promise.resolve(pending).catch(() => {}).then(resetAfterDisconnect);
    }

    function resetAfterDisconnect(): void {
      try {
        options.resetAfterDisconnect();
      } catch (error) {
        options.reportError(error);
      }
    }

    void options.connect().then(() => {
      if (disposed) disposeConnectionAndReset();
    });

    return () => {
      disposed = true;
      window.clearInterval(runtimeStatusTimer);
      disposeFileDrop();
      options.disposeSessionUpdates();
      options.disposeTranscriptScroll();
      options.cancelAllPendingElicitations();
      options.disposeGitCi();
      options.disposeProjectDocuments?.();
      disposeConnectionAndReset();
    };
  }

  return { start };
}
