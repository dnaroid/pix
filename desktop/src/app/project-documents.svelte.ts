import { invoke } from "@tauri-apps/api/core";
import { confirmDesktopDeletion } from "../lib/confirm-deletion";
import { isWorkspaceProjectFilePath, type ProjectFilePreview, type ProjectFileSaveGuard } from "../lib/project-files";
import { getProjectWikiConfig } from "../lib/project-wiki";
import { readWorkspaceConfig } from "./workspace-config-persistence";
import type { KnowledgeCheckRequest, KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import { recordKnowledgeCheck } from "../../../acp/src/knowledge/stamp";
import { createProjectKnowledgeQueue, type ProjectKnowledgeJob } from "./project-knowledge-queue.svelte";
import {
  EMPTY_PROJECT_DOCUMENTS,
  PROJECT_TODO_PATH,
  isEditableProjectMarkdown,
  isCanonicalProjectPlanPath,
  type ProjectDocumentsSnapshot,
} from "../lib/project-documents";

type ProjectDocumentsStoreOptions = {
  workspace: () => string;
  openProjectFile: (path: string) => void | Promise<void>;
  showEmptyFile: (file: ProjectFilePreview) => void;
  previewId: () => number | undefined;
  currentFile?: () => ProjectFilePreview | undefined;
  afterSave: (file: ProjectFilePreview, workspace: string, previewId: number | undefined) => void;
  afterDelete?: (path: string, workspace: string) => void;
  clearError: () => void;
  reportError: (error: unknown) => void;
  checkKnowledge?: (request: KnowledgeCheckRequest, signal: AbortSignal) => Promise<KnowledgeCheckResult>;
  onKnowledgeJobComplete?: (job: ProjectKnowledgeJob) => void;
};

export function createProjectDocumentsStore(options: ProjectDocumentsStoreOptions) {
  let snapshot = $state<ProjectDocumentsSnapshot>(EMPTY_PROJECT_DOCUMENTS);
  let wikiPath = $state<string | null>("wiki");
  let generation = 0;
  let workspaceGeneration = 0;
  const writes = new Map<string, Promise<ProjectFilePreview | undefined>>();
  let removing = $state<string | null>(null);
  let fileMutationReservations = 0;
  const knowledgeQueue = createProjectKnowledgeQueue({
    workspace: options.workspace,
    check: (job, signal) => checkKnowledgeSnapshot(job.workspace, job.path, job.content, signal, job.expectedContent),
    record: async (job, result, isCurrent) => {
      const content = await recordKnowledgeCheck(job.content, result);
      if (!isCurrent()) return false;
      if (content === job.expectedContent) return true;
      return save(job.path, content, {
        expectedContent: job.expectedContent,
        isCurrent: () => isCurrent() && options.workspace() === job.workspace,
      });
    },
    reportError: options.reportError,
    onComplete: options.onKnowledgeJobComplete,
  });

  function reset(): void {
    generation += 1;
    workspaceGeneration += 1;
    knowledgeQueue.reset();
    snapshot = EMPTY_PROJECT_DOCUMENTS;
    wikiPath = "wiki";
    removing = null;
  }

  async function load(projectPath: string): Promise<void> {
    const requestGeneration = ++generation;
    try {
      const next = await invoke<ProjectDocumentsSnapshot>("list_project_documents", {
        workspace: projectPath,
      });
      if (requestGeneration !== generation || options.workspace() !== projectPath) return;
      snapshot = next;
      const config = await readWorkspaceConfig(projectPath);
      if (requestGeneration !== generation || options.workspace() !== projectPath) return;
      wikiPath = getProjectWikiConfig(config?.content).path;
    } catch (error) {
      if (requestGeneration === generation && options.workspace() === projectPath) {
        wikiPath = null;
        options.reportError(error);
      }
    }
  }

  async function refresh(): Promise<void> {
    const workspace = options.workspace();
    if (workspace) await load(workspace);
  }

  function open(path: string, exists = true): void {
    if (!options.workspace() || !isEditableProjectMarkdown(path)) return;
    if (exists) {
      void options.openProjectFile(path);
      return;
    }
    if (path === PROJECT_TODO_PATH) options.showEmptyFile({ path, content: "" });
  }

  async function checkKnowledge(path: string, content: string, signal: AbortSignal): Promise<KnowledgeCheckResult | undefined> {
    if (!/\.(md|markdown)$/iu.test(path)) return undefined;
    const workspace = options.workspace();
    const loaded = options.currentFile?.();
    return checkKnowledgeSnapshot(workspace, path, content, signal, loaded?.path === path ? loaded.content : undefined);
  }

  async function checkKnowledgeSnapshot(workspace: string, path: string, content: string, signal: AbortSignal,
    expectedContent?: string): Promise<KnowledgeCheckResult | undefined> {
    if (!workspace) throw new Error("Choose a project before checking Wiki documents.");
    signal.throwIfAborted();
    const owner = workspaceGeneration;
    const config = await readWorkspaceConfig(workspace);
    signal.throwIfAborted();
    if (owner !== workspaceGeneration || options.workspace() !== workspace) throw new Error("Project changed during Wiki check.");
    wikiPath = getProjectWikiConfig(config?.content).path;
    if (!path.startsWith(`${wikiPath}/`)) return undefined;
    if (!options.checkKnowledge) throw new Error("Wiki contradiction checking is unavailable. Connect the project backend and retry.");
    const result = await options.checkKnowledge({ cwd: workspace, path, content,
      ...(expectedContent !== undefined ? { expectedContent } : {}),
    }, signal);
    signal.throwIfAborted();
    if (owner !== workspaceGeneration || options.workspace() !== workspace) throw new Error("Project changed during Wiki check.");
    return result;
  }

  async function save(path: string, content: string, guard?: ProjectFileSaveGuard): Promise<boolean> {
    const workspace = options.workspace();
    if (!workspace || !isWorkspaceProjectFilePath(path) || removing === path || (guard && !guard.isCurrent())) return false;
    if (fileMutationReservations > 0) {
      options.reportError(new Error("A file operation is in progress. Try saving again when it finishes."));
      return false;
    }
    const requestGeneration = workspaceGeneration;
    const previewId = options.previewId();
    const loadedFile = options.currentFile?.();
    const expectedContent = guard ? guard.expectedContent : loadedFile?.path === path ? loadedFile.content : undefined;
    const isCurrent = () => requestGeneration === workspaceGeneration && options.workspace() === workspace;
    const key = `${workspace}\0${path}`;
    const command = isEditableProjectMarkdown(path) ? "write_project_markdown" : "write_project_file";
    options.clearError();
    try {
      const previous = writes.get(key) ?? Promise.resolve(undefined);
      let writeStarted = false;
      const pending = previous.catch(() => undefined).then((saved) => {
        // A reviewed write retains its raw baseline while waiting in the queue.
        // Recheck ownership here: hashing or an earlier save may have outlived it.
        if (!isCurrent() || (guard && !guard.isCurrent())) return saved;
        writeStarted = true;
        return invoke<ProjectFilePreview>(command, {
          workspace, path, content,
          ...(expectedContent !== undefined ? { expectedContent: guard ? expectedContent : saved?.content ?? expectedContent } : {}),
        });
      }).finally(() => {
        if (writes.get(key) === pending) writes.delete(key);
      });
      writes.set(key, pending);
      const saved = await pending;
      // Once native writing starts, publish its committed baseline even if the
      // draft changes. Preview retains newer edits using its own ownership fence.
      if (!writeStarted || !saved || !isCurrent()) return false;
      options.afterSave(saved, workspace, previewId);
      void load(workspace);
      return true;
    } catch (error) {
      if (isCurrent() && (!guard || guard.isCurrent())) options.reportError(error);
      return false;
    }
  }

  async function removePlan(path: string): Promise<void> {
    const workspace = options.workspace();
    if (!workspace || removing || !isCanonicalProjectPlanPath(path) || !snapshot.plans.includes(path)) return;
    const requestGeneration = workspaceGeneration;
    const isCurrent = () => requestGeneration === workspaceGeneration && options.workspace() === workspace;
    removing = path;
    try {
      if (!await confirmDesktopDeletion(`Delete plan “${path}”?\n\nThe file and any unsaved changes will be lost. This cannot be undone.`, {
        title: "Delete plan?", okLabel: "Delete",
      }) || !isCurrent()) return;
      // Let an in-flight save finish first; new saves of this plan are blocked.
      await writes.get(`${workspace}\0${path}`)?.catch(() => {});
      if (!isCurrent()) return;
      options.clearError();
      await invoke("delete_project_entry", { workspace, path });
      if (!isCurrent()) return;
      generation += 1;
      snapshot = { ...snapshot, plans: snapshot.plans.filter((candidate) => candidate !== path) };
      options.afterDelete?.(path, workspace);
      await load(workspace);
    } catch (error) {
      if (isCurrent()) options.reportError(error);
    } finally {
      if (isCurrent()) removing = null;
    }
  }

  return {
    async prepareFileMutation(): Promise<() => void> {
      fileMutationReservations++;
      await Promise.allSettled([...writes.values()]);
      let released = false;
      return () => { if (!released) { released = true; fileMutationReservations--; } };
    },
    get snapshot() { return snapshot; },
    get generation() { return workspaceGeneration; },
    get wikiPath() { return wikiPath; },
    get removing() { return removing; },
    get knowledgeJobs() { return knowledgeQueue.jobs; },
    enqueueKnowledgeCheck: knowledgeQueue.enqueue,
    cancelKnowledgeCheck: knowledgeQueue.cancel,
    dismissKnowledgeCheck: knowledgeQueue.dismiss,
    getKnowledgeJob: knowledgeQueue.find,
    reset,
    load,
    refresh,
    open,
    save,
    checkKnowledge,
    removePlan,
  };
}
