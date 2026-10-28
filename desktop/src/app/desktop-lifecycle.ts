import { installDesktopFileDrop } from "../lib/desktop-file-drop";

const RUNTIME_STATUS_REFRESH_MS = 5 * 60_000;

type DesktopLifecycleOptions = {
  activeSessionId: () => string | null;
  activeSessionRuntimeReady: () => boolean;
  refreshRuntimeStatus: (sessionId: string, force?: boolean) => void | Promise<void>;
  disposeGitCi: () => void;
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

    void options.connect().then(() => {
      if (disposed) void options.disposeConnection();
    });

    return () => {
      disposed = true;
      window.clearInterval(runtimeStatusTimer);
      disposeFileDrop();
      options.disposeSessionUpdates();
      options.disposeTranscriptScroll();
      options.cancelAllPendingElicitations();
      options.disposeGitCi();
      void options.disposeConnection();
    };
  }

  return { start };
}
