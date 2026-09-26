import type { createActiveSessionState } from "./active-session-state.svelte";
import type { createDesktopConnectionServices } from "./desktop-connection-services";
import { createDesktopLifecycle } from "./desktop-lifecycle";
import type { createDesktopProjectServices } from "./desktop-project-services";
import type { createDesktopPromptServices } from "./desktop-prompt-services";
import type { createDesktopSessionServices } from "./desktop-session-services";
import type { createQuestionImageController } from "./question-images";

type ActiveSessionState = ReturnType<typeof createActiveSessionState>;
type ConnectionServices = ReturnType<typeof createDesktopConnectionServices>;
type ProjectServices = ReturnType<typeof createDesktopProjectServices>;
type PromptServices = ReturnType<typeof createDesktopPromptServices>;
type SessionServices = ReturnType<typeof createDesktopSessionServices>;
type QuestionImages = ReturnType<typeof createQuestionImageController>;

type PromptComposerHandle = {
  insertPaths: (paths: readonly string[]) => Promise<void>;
};

type DesktopLifecycleServicesOptions = {
  state: ActiveSessionState;
  workspace: () => string;
  setWorkspace: (workspace: string) => void;
  setDragActive: (active: boolean) => void;
  draftSessionTabActive: () => boolean;
  sessionMutationRunning: () => boolean;
  activePendingElicitationKind: () => string | undefined;
  promptComposer: () => PromptComposerHandle | null;
  sessionServices: SessionServices;
  projectServices: ProjectServices;
  questionImages: QuestionImages;
  connection: ConnectionServices;
  promptServices: PromptServices;
  disposeTranscriptScroll: () => void;
  cancelAllPendingElicitations: () => void;
  reportError: (error: unknown) => void;
};

export function createDesktopLifecycleServices(options: DesktopLifecycleServicesOptions) {
  return createDesktopLifecycle({
    activeSessionId: () => options.state.sessionId,
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    refreshRuntimeStatus: options.sessionServices.runtime.refreshStatus,
    refreshWorkspaceBranch: options.projectServices.git.refreshStatusBranch,
    disposeGitCi: options.projectServices.gitCi.dispose,
    restoreProjects: () => {
      const restored = options.projectServices.workspace.restore();
      options.setWorkspace(restored.workspace);
      options.sessionServices.tabs.setActiveSessionIds(restored.activeSessionIds);
      options.sessionServices.tabs.setSessionTabIds(restored.sessionTabIds);
    },
    refreshProjectColors: () => options.projectServices.workspace.refreshColors(
      options.projectServices.workspace.recentProjects,
    ),
    restoreSessionInspector: options.sessionServices.inspectorPreference.restore,
    workspace: options.workspace,
    loadWorkspaceData: (workspace) => {
      void options.projectServices.tasks.load(workspace);
      void options.projectServices.documents.load(workspace);
      void options.projectServices.workspace.loadPreferences(workspace);
      void options.projectServices.registry.refreshProjectInitialization();
      void options.projectServices.registry.autoCleanProject(workspace);
    },
    canAcceptDroppedAttachments: options.questionImages.canAcceptDroppedAttachments,
    setDragActive: options.setDragActive,
    activeCustomQuestionId: options.questionImages.activeCustomQuestionId,
    addQuestionImagePaths: options.questionImages.addQuestionImagePaths,
    canInsertPromptAttachments: () => (
      (Boolean(options.state.sessionId) || options.draftSessionTabActive())
      && !options.sessionMutationRunning()
      && options.activePendingElicitationKind() !== "question"
    ),
    insertPromptPaths: (paths) => options.promptComposer()?.insertPaths(paths),
    connect: options.connection.connect,
    disposeConnection: options.connection.dispose,
    disposeSessionUpdates: options.promptServices.updates.dispose,
    disposeTranscriptScroll: options.disposeTranscriptScroll,
    cancelAllPendingElicitations: options.cancelAllPendingElicitations,
    reportError: options.reportError,
  });
}
