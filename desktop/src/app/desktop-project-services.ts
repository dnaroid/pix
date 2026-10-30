import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import { isCanonicalProjectPlanPath } from "../lib/project-documents";
import type { TranscriptState } from "../lib/transcript";
import type { WorkbenchTabId } from "../lib/workbench-tabs";
import { createGitCiStore } from "./git-ci.svelte";
import { createGitWorkspaceStore } from "./git-workspace.svelte";
import { toasts } from "./toasts.svelte";
import { createPreviewStore } from "./preview.svelte";
import { createProjectDocumentsStore } from "./project-documents.svelte";
import { createPlanLaunchesStore } from "./plan-launches.svelte";
import { createProjectTasksStore } from "./project-tasks.svelte";
import { createProjectWorkspaceStore } from "./project-workspace.svelte";
import { createRegistryStore } from "./registry.svelte";

type DesktopProjectServicesOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  revealProjectEntry?: (path: string) => Promise<void>;
  operationRunning: () => boolean;
  sessionWorkspace: (sessionId: string) => string | undefined;
  transcript: () => TranscriptState;
  prepareAttachment: (attachment: Attachment) => Promise<void>;
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  activeConversationWorkbenchTabId: () => WorkbenchTabId | null;
  setActiveWorkbenchTabId: (id: WorkbenchTabId | null) => void;
  nextWorkbenchAuxOrder: () => number;
  setErrorMessage: (message: string | null) => void;
  clearError: () => void;
  reportError: (error: unknown) => void;
};

export function createDesktopProjectServices(options: DesktopProjectServicesOptions) {
  let registry!: ReturnType<typeof createRegistryStore>;
  let git!: ReturnType<typeof createGitWorkspaceStore>;
  const tasks = createProjectTasksStore({
    workspace: options.workspace,
    afterSave: () => registry.scheduleProjectSync("tasks"),
    reportError: options.reportError,
  });
  const projectWorkspace = createProjectWorkspaceStore({
    workspace: options.workspace,
    reportError: options.reportError,
    afterSave: () => registry.scheduleProjectSync("workspace"),
  });
  const preview = createPreviewStore({
    workspace: options.workspace,
    revealProjectEntry: options.revealProjectEntry,
    loadExternalEditor: async () => {
      await projectWorkspace.loadPreferences(options.workspace());
      return projectWorkspace.externalEditor;
    },
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
    checkKnowledge: (request, signal) => {
      const client = options.client();
      if (!client) throw new Error("Connect the project backend before checking Wiki contradictions.");
      return client.checkKnowledge(request, signal);
    },
    openProjectFile: preview.openProjectFile,
    showEmptyFile: (file) => preview.show({ kind: "file", file }, "replace"),
    previewId: () => preview.active?.id,
    currentFile: () => preview.active?.kind === "file" ? preview.active.file : undefined,
    afterSave: (file, _workspace, previewId) => {
      const active = preview.active;
      if (active && active.id === previewId && active.kind === "file"
        && active.file.path === file.path) preview.replaceCurrentFile(file);
      if (isCanonicalProjectPlanPath(file.path)) registry.scheduleProjectSync("plans");
    },
    onKnowledgeJobComplete: (job) => {
      if (options.workspace() !== job.workspace) return;
      const russian = job.result?.reportLanguage === "ru";
      const failed = job.state === "failed";
      const clear = job.result?.status === "clear";
      const message = failed
        ? russian ? "Проверка Wiki не завершилась" : "Wiki check failed"
        : job.error
          ? russian ? "Отчёт Wiki готов; отметка не сохранена" : "Wiki report ready; check mark was not saved"
          : clear
            ? russian ? "Проверка Wiki завершена: противоречий не найдено" : "Wiki check complete: no contradictions found"
            : job.result?.status === "conflicts"
              ? russian ? "В Wiki найдены возможные противоречия" : "Potential Wiki contradictions found"
              : russian ? "Проверка Wiki завершена не полностью" : "Wiki check is incomplete";
      const input = {
        message,
        detail: job.path,
        source: "Wiki",
        key: `wiki-check:${job.workspace}:${job.id}`,
        log: false,
        actions: [{
          label: russian ? "Открыть страницу" : "Open page",
          run: async () => {
            if (options.workspace() === job.workspace) {
              await preview.openProjectFile(job.path, "push", undefined, false, "document");
            }
          },
        }],
      };
      if (failed) toasts.error(input);
      else if (clear && !job.error) toasts.success(input);
      else toasts.warning(input);
    },
    afterDelete: (path) => {
      preview.invalidateFileLoads();
      if (preview.active?.kind === "file" && preview.active.file.path === path) preview.close();
      registry.scheduleProjectSync("plans");
    },
    clearError: options.clearError,
    reportError: options.reportError,
  });
  registry = createRegistryStore({
    client: options.client,
    operationRunning: options.operationRunning,
    workspace: options.workspace,
    sessionWorkspace: options.sessionWorkspace,
    setErrorMessage: options.setErrorMessage,
    loadProjectTasks: tasks.load,
    loadProjectDocuments: documents.load,
    loadWorkspaceSettings: (workspace) => {
      if (options.workspace() === workspace) projectWorkspace.refreshColors([workspace]);
    },
    reportError: options.reportError,
  });
  const gitCi = createGitCiStore({
    workspace: options.workspace,
    onTargetStale: () => void git.refresh(),
  });
  git = createGitWorkspaceStore({
    workspace: options.workspace,
    onSnapshotChange: gitCi.updateTarget,
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
    notify: (message) => { toasts.success({ message, source: "Git", key: `git:${message}` }); },
  });

  const planLaunches = createPlanLaunchesStore();

  return {
    tasks,
    workspace: projectWorkspace,
    preview,
    documents,
    planLaunches,
    registry,
    git,
    gitCi,
  };
}

export type DesktopProjectServices = ReturnType<typeof createDesktopProjectServices>;
