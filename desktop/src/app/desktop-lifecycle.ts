import { getCurrentWindow } from "@tauri-apps/api/window";

const RUNTIME_STATUS_REFRESH_MS = 5 * 60_000;
const GIT_BRANCH_REFRESH_MS = 30_000;

type DesktopLifecycleOptions = {
  activeSessionId: () => string | null;
  activeSessionRuntimeReady: () => boolean;
  refreshRuntimeStatus: (sessionId: string, force?: boolean) => void | Promise<void>;
  refreshWorkspaceBranch: () => void | Promise<void>;
  restoreProjects: () => void;
  refreshProjectColors: () => void;
  restoreSessionInspector: () => void;
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
    let unlistenDragDrop: (() => void) | undefined;
    const runtimeStatusTimer = window.setInterval(() => {
      const sessionId = options.activeSessionId();
      if (sessionId && options.activeSessionRuntimeReady()) {
        void options.refreshRuntimeStatus(sessionId, true);
      }
    }, RUNTIME_STATUS_REFRESH_MS);
    const gitBranchTimer = window.setInterval(() => {
      if (options.workspace()) void options.refreshWorkspaceBranch();
    }, GIT_BRANCH_REFRESH_MS);

    options.restoreProjects();
    options.refreshProjectColors();
    options.restoreSessionInspector();
    const workspace = options.workspace();
    if (workspace) {
      options.loadWorkspaceData(workspace);
      void options.refreshWorkspaceBranch();
    }

    void getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") {
        options.setDragActive(options.canAcceptDroppedAttachments());
        return;
      }
      if (payload.type === "leave") {
        options.setDragActive(false);
        return;
      }
      if (payload.type !== "drop") return;

      options.setDragActive(false);
      const questionId = options.activeCustomQuestionId();
      if (questionId) {
        void options.addQuestionImagePaths(questionId, payload.paths);
      } else if (options.canInsertPromptAttachments()) {
        void options.insertPromptPaths(payload.paths);
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenDragDrop = unlisten;
    }).catch(options.reportError);

    void options.connect().then(() => {
      if (disposed) void options.disposeConnection();
    });

    return () => {
      disposed = true;
      window.clearInterval(runtimeStatusTimer);
      window.clearInterval(gitBranchTimer);
      unlistenDragDrop?.();
      options.disposeSessionUpdates();
      options.disposeTranscriptScroll();
      options.cancelAllPendingElicitations();
      void options.disposeConnection();
    };
  }

  return { start };
}
