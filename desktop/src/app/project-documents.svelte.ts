import { invoke } from "@tauri-apps/api/core";
import { confirmDesktopDeletion } from "../lib/confirm-deletion";
import { isWorkspaceProjectFilePath, type ProjectFilePreview, type ProjectFileSaveGuard } from "../lib/project-files";
import { getProjectWikiConfig } from "../lib/project-wiki";
import { readWorkspaceConfig } from "./workspace-config-persistence";
import type { KnowledgeCheckRequest, KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import { readKnowledgeCheckStamp, recordKnowledgeAutoCheckAttempt, recordKnowledgeCheck } from "../../../acp/src/knowledge/stamp";
import { createProjectKnowledgeQueue, type ProjectKnowledgeJob } from "./project-knowledge-queue.svelte";
import { createKnowledgeJudgeGate } from "./knowledge-judge-gate";
import { createWikiAutoCheckScheduler } from "./wiki-auto-check.svelte";
import { createWikiAutoCheckSettingsOwner } from "./wiki-auto-check-settings.svelte";
import { getWikiAutoCheckSettings } from "../lib/wiki-auto-check-config";
import { listWikiCheckDirectory, readWikiCheckDocument, releaseWikiCheckInventory } from "../lib/wiki-check-inventory";
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
  knowledgeBackgroundReady?: () => boolean;
  reportBackgroundKnowledgeError?: (error: unknown, workspace?: string) => void;
};

export function createProjectDocumentsStore(options: ProjectDocumentsStoreOptions) {
  let snapshot = $state<ProjectDocumentsSnapshot>(EMPTY_PROJECT_DOCUMENTS);
  let wikiPath = $state<string | null>("wiki");
  let generation = 0;
  let workspaceGeneration = 0;
  const writes = new Map<string, Promise<ProjectFilePreview | undefined>>();
  let removing = $state<string | null>(null);
  let fileMutationReservations = 0;
  const judge = createKnowledgeJudgeGate();
  let automatic!: ReturnType<typeof createWikiAutoCheckScheduler>;
  const reportBackground = (error: unknown, workspace = options.workspace()) =>
    (options.reportBackgroundKnowledgeError ?? options.reportError)(error, workspace);
  const autoSettings = createWikiAutoCheckSettingsOwner({
    workspace: options.workspace,
    generation: () => workspaceGeneration,
    pause: () => automatic?.reset(),
    resume: () => { if (options.knowledgeBackgroundReady) automatic?.start(); },
    reportError: reportBackground,
  });
  const knowledgeQueue = createProjectKnowledgeQueue({
    workspace: options.workspace,
    check: (job, signal) => checkKnowledgeSnapshot(job.workspace, job.path, job.content, signal, job.expectedContent, job.origin === "background"),
    record: async (job, result, isCurrent) => {
      let content = await recordKnowledgeCheck(job.content, result, new Date(), job.expectedContent);
      const runId = await currentAutoPass(job, isCurrent);
      if (runId && result.status !== "clear") {
        content = await recordKnowledgeAutoCheckAttempt(content, runId, result.documentHash);
      }
      if (!isCurrent()) return false;
      if (content === job.expectedContent) return true;
      return saveKnowledgeMetadata(job.path, content, job.expectedContent,
        () => isCurrent() && options.workspace() === job.workspace, job.origin === "background");
    },
    recordFailure: async (job, isCurrent) => {
      const runId = await currentAutoPass(job, isCurrent);
      if (!runId || !isCurrent()) return false;
      // A failed explicit recheck does not invalidate a still-current historical success.
      if (await readKnowledgeCheckStamp(job.expectedContent)) return isCurrent();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(job.content));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const content = await recordKnowledgeAutoCheckAttempt(job.expectedContent, runId, hash);
      return saveKnowledgeMetadata(job.path, content, job.expectedContent, isCurrent, true);
    },
    reportError: options.reportError,
    reportBackgroundError: reportBackground,
    onComplete: job => { automatic?.jobCompleted(job); options.onKnowledgeJobComplete?.(job); },
  });
  automatic = createWikiAutoCheckScheduler({
    workspace: options.workspace,
    readConfig: autoSettings.read,
    listDirectory: listWikiCheckDirectory,
    releaseInventory: releaseWikiCheckInventory,
    readFile: readWikiCheckDocument,
    jobs: () => knowledgeQueue.jobs,
    enqueue: knowledgeQueue.enqueue,
    cancel: knowledgeQueue.cancel,
    cancelQueuedBackground: knowledgeQueue.cancelQueuedBackground,
    ready: options.knowledgeBackgroundReady,
    reportError: reportBackground,
    recordSkipped: async (input, isCurrent) => {
      // Oversized pages never reach the model; avoid delaying discovery just to
      // persist their optional checkpoint while another check owns the corpus.
      const content = await recordKnowledgeAutoCheckAttempt(input.content, input.runId, input.contentHash);
      return saveKnowledgeMetadata(input.path, content, input.content, isCurrent, true, true);
    },
  });

  async function currentAutoPass(job: ProjectKnowledgeJob, isCurrent: () => boolean): Promise<string | undefined> {
    if ((!options.knowledgeBackgroundReady && !job.autoCheckRunId) || !isCurrent()) return undefined;
    const config = await readWorkspaceConfig(job.workspace);
    if (!isCurrent() || options.workspace() !== job.workspace) return undefined;
    if (!job.path.startsWith(getProjectWikiConfig(config?.content).path + "/")) return undefined;
    const setting = getWikiAutoCheckSettings(config?.content);
    return setting.enabled && setting.runId ? setting.runId : job.autoCheckRunId;
  }

  function reset(): void {
    generation += 1;
    workspaceGeneration += 1;
    autoSettings.reset();
    automatic.reset();
    knowledgeQueue.reset();
    snapshot = EMPTY_PROJECT_DOCUMENTS;
    wikiPath = "wiki";
    removing = null;
  }

  async function load(projectPath: string): Promise<void> {
    const requestGeneration = ++generation;
    if (options.knowledgeBackgroundReady && options.workspace() === projectPath) automatic.start();
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
    expectedContent?: string, background = false): Promise<KnowledgeCheckResult | undefined> {
    if (!workspace) throw new Error("Choose a project before checking Wiki documents.");
    signal.throwIfAborted();
    const owner = workspaceGeneration;
    const config = await readWorkspaceConfig(workspace);
    signal.throwIfAborted();
    if (owner !== workspaceGeneration || options.workspace() !== workspace) throw new Error("Project changed during Wiki check.");
    wikiPath = getProjectWikiConfig(config?.content).path;
    if (!path.startsWith(`${wikiPath}/`)) return undefined;
    if (!options.checkKnowledge) throw new Error("Wiki contradiction checking is unavailable. Connect the project backend and retry.");
    const result = await judge.run(() => {
      signal.throwIfAborted();
      if (owner !== workspaceGeneration || options.workspace() !== workspace) throw new Error("Project changed during Wiki check.");
      return options.checkKnowledge!({ cwd: workspace, path, content,
        ...(expectedContent !== undefined ? { expectedContent } : {}),
      }, signal);
    }, signal, background);
    signal.throwIfAborted();
    if (owner !== workspaceGeneration || options.workspace() !== workspace) throw new Error("Project changed during Wiki check.");
    return result;
  }

  async function saveKnowledgeMetadata(path: string, content: string, expectedContent: string,
    isCurrent: () => boolean, background: boolean, onlyIfIdle = false): Promise<boolean> {
    if (!isCurrent()) return false;
    // The evidence snapshot detects raw file changes too. App-owned report
    // writes must not invalidate another model comparison still in progress.
    const operation = async () => {
      if (!isCurrent()) return false;
      if (background) {
        const workspace = options.workspace();
        const config = await readWorkspaceConfig(workspace);
        if (!isCurrent()) return false;
        const root = getProjectWikiConfig(config?.content).path;
        if (!path.startsWith(root + "/")) return false;
        const current = await readWikiCheckDocument(workspace, root, path, new AbortController().signal);
        if (!isCurrent() || current.content !== expectedContent) return false;
      }
      return save(path, content, { expectedContent, isCurrent }, background);
    };
    const signal = new AbortController().signal;
    return onlyIfIdle ? judge.tryRunIfIdle(operation, signal) ?? false : judge.run(operation, signal, background);
  }

  /**
   * Writes a user verdict into a page's report block. It waits for the judge slot
   * like other report writes so an in-flight comparison is not invalidated, and
   * the native compare-and-swap rejects any concurrent change of the raw file.
   */
  function knowledgeDecisionWriter() {
    // Captured once per decision operation, so a project switch (even A→B→A) fences every later write.
    const workspace = options.workspace(), owner = workspaceGeneration;
    const isCurrent = () => owner === workspaceGeneration && options.workspace() === workspace;
    return {
      isCurrent,
      write: (path: string, content: string, expectedContent: string): Promise<boolean> => isCurrent()
        ? saveKnowledgeMetadata(path, content, expectedContent, isCurrent, false) : Promise.resolve(false),
    };
  }

  /**
   * Compare-and-swap writer for inline Wiki edits from the comparison tab. Like a
   * Preview save, it does not wait for the judge: changing the page invalidates an
   * in-flight check of it. Fenced to the project generation current at creation.
   */
  function wikiEditWriter() {
    const workspace = options.workspace(), owner = workspaceGeneration;
    const isCurrent = () => owner === workspaceGeneration && options.workspace() === workspace;
    return {
      isCurrent,
      write: (path: string, content: string, expectedContent: string): Promise<boolean> => isCurrent()
        ? save(path, content, { expectedContent, isCurrent }) : Promise.resolve(false),
    };
  }

  async function save(path: string, content: string, guard?: ProjectFileSaveGuard, quiet = false): Promise<boolean> {
    const workspace = options.workspace();
    if (!workspace || !isWorkspaceProjectFilePath(path) || removing === path || (guard && !guard.isCurrent())) return false;
    if (fileMutationReservations > 0) {
      (quiet ? reportBackground : options.reportError)(new Error("A file operation is in progress. Try saving again when it finishes."));
      return false;
    }
    const requestGeneration = workspaceGeneration;
    const previewId = options.previewId();
    const loadedFile = options.currentFile?.();
    const expectedContent = guard ? guard.expectedContent : loadedFile?.path === path ? loadedFile.content : undefined;
    const isCurrent = () => requestGeneration === workspaceGeneration && options.workspace() === workspace;
    const key = `${workspace}\0${path}`;
    const command = isEditableProjectMarkdown(path) ? "write_project_markdown" : "write_project_file";
    if (!quiet) options.clearError();
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
      if (isCurrent() && (!guard || guard.isCurrent())) (quiet ? reportBackground : options.reportError)(error);
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
    get wikiAutoCheck() { return { ...automatic.view, enabled: autoSettings.enabled ?? automatic.view.enabled, saving: autoSettings.saving,
      error: autoSettings.error ?? automatic.view.error }; },
    setWikiAutoCheck: autoSettings.setEnabled,
    enqueueKnowledgeCheck: knowledgeQueue.enqueue,
    cancelKnowledgeCheck: knowledgeQueue.cancel,
    dismissKnowledgeCheck: knowledgeQueue.dismiss,
    getKnowledgeJob: knowledgeQueue.find,
    reset,
    dispose(): void { reset(); automatic.dispose(); },
    load,
    refresh,
    open,
    save,
    knowledgeDecisionWriter,
    wikiEditWriter,
    checkKnowledge,
    removePlan,
  };
}
