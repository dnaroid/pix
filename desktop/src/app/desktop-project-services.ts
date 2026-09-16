import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import { PROJECT_TODO_PATH } from "../lib/project-documents";
import type { TranscriptState } from "../lib/transcript";
import type { WorkbenchTabId } from "../lib/workbench-tabs";
import { createGitWorkspaceStore } from "./git-workspace.svelte";
import { createPreviewStore } from "./preview.svelte";
import { createProjectDocumentsStore } from "./project-documents.svelte";
import { createProjectTasksStore } from "./project-tasks.svelte";
import { createProjectWorkspaceStore } from "./project-workspace.svelte";
import { createRegistryStore } from "./registry.svelte";

type DesktopProjectServicesOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  activeSessionId: () => string | null;
  activeSessionRuntimeReady: () => boolean;
  operationRunning: () => boolean;
  promptRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  sessionWorkspace: (sessionId: string) => string | undefined;
  transcript: () => TranscriptState;
  prepareAttachment: (attachment: Attachment) => Promise<void>;
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  activeConversationWorkbenchTabId: () => WorkbenchTabId | null;
  setActiveWorkbenchTabId: (id: WorkbenchTabId | null) => void;
  nextWorkbenchAuxOrder: () => number;
  setOperationRunning: (running: boolean) => void;
  setErrorMessage: (message: string | null) => void;
  clearError: () => void;
  reportError: (error: unknown) => void;
};

export function createDesktopProjectServices(options: DesktopProjectServicesOptions) {
  let registry!: ReturnType<typeof createRegistryStore>;
  const tasks = createProjectTasksStore({
    workspace: options.workspace,
    afterSave: () => registry.scheduleProjectSync("tasks"),
    reportError: options.reportError,
  });
  const projectWorkspace = createProjectWorkspaceStore({
    workspace: options.workspace,
    reportError: options.reportError,
  });
  const preview = createPreviewStore({
    workspace: options.workspace,
    activeWorkbenchTabId: options.activeWorkbenchTabId,
    activeConversationWorkbenchTabId: options.activeConversationWorkbenchTabId,
    setActiveWorkbenchTabId: options.setActiveWorkbenchTabId,
    nextWorkbenchAuxOrder: options.nextWorkbenchAuxOrder,
    prepareAttachment: options.prepareAttachment,
    preparedAttachment: (attachment) => options.transcript().items
      .flatMap((item) => item.attachments)
      .find((candidate) => candidate.id === attachment.id) ?? attachment,
    reportError: options.reportError,
    setErrorMessage: (message) => options.setErrorMessage(message),
  });

  const documents = createProjectDocumentsStore({
    workspace: options.workspace,
    openProjectFile: preview.openProjectFile,
    showEmptyFile: (file) => preview.show({ kind: "file", file }, "replace"),
    previewId: () => preview.active?.id,
    afterSave: (file, _workspace, previewId) => {
      if (preview.active?.id === previewId) preview.replaceCurrentFile(file);
      registry.scheduleProjectSync(file.path === PROJECT_TODO_PATH ? "todo" : "plans");
    },
    clearError: options.clearError,
    reportError: options.reportError,
  });
  registry = createRegistryStore({
    client: options.client,
    activeSessionId: options.activeSessionId,
    sessionRuntimeReady: options.activeSessionRuntimeReady,
    operationRunning: options.operationRunning,
    promptRunning: options.promptRunning,
    sessionHistoryLoading: options.sessionHistoryLoading,
    workspace: options.workspace,
    sessionWorkspace: options.sessionWorkspace,
    setOperationRunning: options.setOperationRunning,
    setErrorMessage: options.setErrorMessage,
    loadProjectTasks: tasks.load,
    loadProjectDocuments: documents.load,
    reportError: options.reportError,
  });
  const git = createGitWorkspaceStore({
    workspace: options.workspace,
    previewDirty: () => preview.dirty,
    reloadProject: async (workspace) => {
      preview.close();
      await Promise.all([
        tasks.load(workspace),
        documents.load(workspace),
        projectWorkspace.loadPreferences(workspace),
      ]);
    },
    activeWorkbenchTabId: options.activeWorkbenchTabId,
    activeConversationWorkbenchTabId: options.activeConversationWorkbenchTabId,
    setActiveWorkbenchTabId: options.setActiveWorkbenchTabId,
    nextWorkbenchAuxOrder: options.nextWorkbenchAuxOrder,
  });

  return {
    tasks,
    workspace: projectWorkspace,
    preview,
    documents,
    registry,
    git,
  };
}

export type DesktopProjectServices = ReturnType<typeof createDesktopProjectServices>;
