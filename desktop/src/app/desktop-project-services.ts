import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import { isCanonicalProjectPlanPath } from "../lib/project-documents";
import type { TranscriptState } from "../lib/transcript";
import type { WorkbenchTabId } from "../lib/workbench-tabs";
import { createDiagnosticLogger } from "../lib/diagnostic-logging";
import { createGitCiStore } from "./git-ci.svelte";
import { createGitWorkspaceStore } from "./git-workspace.svelte";
import { toasts } from "./toasts.svelte";
import { createPreviewStore } from "./preview.svelte";
import { createProjectDocumentsStore } from "./project-documents.svelte";
import { createPlanLaunchesStore } from "./plan-launches.svelte";
import { createProjectTasksStore } from "./project-tasks.svelte";
import { createProjectWorkspaceStore } from "./project-workspace.svelte";
import { createRegistryStore } from "./registry.svelte";
import { createWikiConflictNotifications } from "./wiki-conflict-notifications";
import { createWikiConsistencyOwner } from "./wiki-consistency-owner.svelte";
import { createWikiConflictsRecheck } from "./wiki-conflicts-recheck.svelte";
import type { WikiConflictsOpenInput } from "./workbench-wiki-conflicts.svelte";
import { readWikiCheckDocument } from "../lib/wiki-check-inventory";

type DesktopProjectServicesOptions = {
  client: () => AcpClient | null;
  knowledgeBackgroundReady?: () => boolean;
  workspace: () => string;
  revealProjectEntry?: (path: string) => Promise<void>;
  openKnowledgeChecks?: () => void | Promise<void>;
  openWikiConflicts?: (input: WikiConflictsOpenInput) => void;
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

  let documents!: ReturnType<typeof createProjectDocumentsStore>;
  const backgroundDiagnostics = createDiagnosticLogger(() => ({ workspace: options.workspace() }));
  const knowledgeNotifications = createWikiConflictNotifications({
    workspace: options.workspace,
    generation: () => documents.generation,
    notify: input => { toasts.error(input); },
    openPage: path => preview.openProjectFile(path, "push", undefined, false, "document"),
    openChecks: options.openKnowledgeChecks,
    openConflicts: options.openWikiConflicts,
    reportError: error => backgroundDiagnostics.warn("wiki:notification-failed", error),
  });
  documents = createProjectDocumentsStore({
    workspace: options.workspace,
    knowledgeBackgroundReady: options.knowledgeBackgroundReady ?? (() => Boolean(options.client())),
    reportBackgroundKnowledgeError: (error, workspace = options.workspace()) =>
      createDiagnosticLogger(() => ({ workspace })).warn("wiki:background-check", error),
    checkKnowledge: (request, signal) => {
      const client = options.client();
      if (!client) throw new Error("Connect the project backend before checking Wiki contradictions.");
      return client.checkKnowledge(request, signal);
    },
    openProjectFile: preview.openProjectFile,
    showEmptyFile: (file) => preview.show({ kind: "file", file }, "replace"),
    previewId: () => preview.active?.id,
    currentFile: () => preview.active?.kind === "file" ? preview.active.file : undefined,
    afterSave: (file, workspace, previewId) => {
      if (workspace !== options.workspace()) return;
      const active = preview.active;
      if (active && active.id === previewId && active.kind === "file"
        && active.file.path === file.path) preview.replaceCurrentFile(file);
      if (isCanonicalProjectPlanPath(file.path)) registry.scheduleProjectSync("plans");
    },
    onKnowledgeJobComplete: job => {
      // A completed check rewrites its page report; refresh findings without waiting for the timer.
      wikiConsistency.refresh();
      return knowledgeNotifications.complete(job);
    },
    afterDelete: (path) => {
      preview.invalidateFileLoads();
      if (preview.active?.kind === "file" && preview.active.file.path === path) preview.close();
      registry.scheduleProjectSync("plans");
    },
    clearError: options.clearError,
    reportError: options.reportError,
  });
  const wikiConsistency = createWikiConsistencyOwner({
    workspace: options.workspace,
    wikiPath: () => documents.wikiPath,
    reportError: error => backgroundDiagnostics.warn("wiki:consistency-status-failed", error),
  });
  const wikiConflictsRecheck = createWikiConflictsRecheck({
    workspace: options.workspace,
    wikiPath: wikiConsistency.wikiPath,
    jobs: () => documents.knowledgeJobs,
    read: (workspace, wikiPath, path, signal) => readWikiCheckDocument(workspace, wikiPath, path, signal),
    enqueue: input => documents.enqueueKnowledgeCheck(input),
    reportError: error => {
      backgroundDiagnostics.warn("wiki:conflicts-recheck-failed", error);
      options.reportError(error);
    },
  });
  // The Wiki root becomes known after the project documents load.
  const loadDocuments = async (workspace: string) => {
    await documents.load(workspace);
    wikiConsistency.refresh();
  };
  registry = createRegistryStore({
    client: options.client,
    operationRunning: options.operationRunning,
    workspace: options.workspace,
    sessionWorkspace: options.sessionWorkspace,
    setErrorMessage: options.setErrorMessage,
    loadProjectTasks: tasks.load,
    loadProjectDocuments: loadDocuments,
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
        loadDocuments(workspace),
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
    loadDocuments,
    wikiConsistency,
    wikiConflictsRecheck,
    planLaunches,
    registry,
    git,
    gitCi,
  };
}

export type DesktopProjectServices = ReturnType<typeof createDesktopProjectServices>;
