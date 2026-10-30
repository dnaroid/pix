import { untrack } from "svelte";
import { confirmDesktopAction } from "../lib/confirm-action";
import type { ProjectFilePreview, ProjectFileSaveGuard } from "../lib/project-files";
import type { KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import type { ManualKnowledgeCheckInput, ProjectKnowledgeJob } from "../app/project-knowledge-queue.svelte";
import { readKnowledgeCheckStamp, readKnowledgeReport, recordKnowledgeCheck, preserveKnowledgeReport, KNOWLEDGE_REPORT_PREFIX, stripKnowledgeCheckStamp, type KnowledgeCheckStamp } from "../../../acp/src/knowledge/stamp";

type KnowledgeCheck = (path: string, content: string, signal: AbortSignal) => Promise<KnowledgeCheckResult | undefined>;
type SavedKnowledgeReport = NonNullable<Awaited<ReturnType<typeof readKnowledgeReport>>>;

interface DraftSnapshot {
  readonly editGeneration: number;
  readonly knowledgeGeneration: number;
  readonly previewId: number;
  readonly workspace: string;
  readonly path: string;
  readonly editing: boolean;
  readonly content: string;
  readonly loadedContent: string;
}

interface PendingCheck {
  readonly snapshot: DraftSnapshot;
  readonly controller: AbortController;
}
interface PendingWrite {
  readonly savingOwner: object;
  readonly snapshot: DraftSnapshot;
  readonly content: string;
}
interface StampSource {
  readonly previewId: number;
  readonly workspace: string;
  readonly path: string;
  readonly content: string;
}

function documentBody(file: ProjectFilePreview | undefined): string {
  if (!file) return "";
  return /\.(md|markdown)$/iu.test(file.path) && !file.virtualWikiDirectory
    ? stripKnowledgeCheckStamp(file.content) : file.content;
}

/** Release UI ownership promptly even if a provider ignores cancellation. */
async function requestCheck(check: KnowledgeCheck, snapshot: DraftSnapshot, signal: AbortSignal): Promise<KnowledgeCheckResult | undefined> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<KnowledgeCheckResult | undefined>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      try { check(snapshot.path, snapshot.content, signal).then(resolve, reject); }
      catch (error) { reject(error); }
    });
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

interface PreviewEditorControllerOptions {
  readonly previewId: () => number;
  readonly file: () => ProjectFilePreview | undefined;
  readonly editable: () => boolean;
  readonly workspace?: () => string;
  readonly onSaveProjectFile: () => ((path: string, content: string, guard?: ProjectFileSaveGuard) => Promise<boolean>) | undefined;
  readonly onCheckKnowledge?: () => KnowledgeCheck | undefined;
  readonly knowledgeJobs?: () => readonly ProjectKnowledgeJob[];
  readonly onEnqueueKnowledgeCheck?: () => ((input: ManualKnowledgeCheckInput) => number | undefined) | undefined;
  readonly onCancelKnowledgeCheck?: () => ((id: number) => void) | undefined;
  readonly onKnowledgeCheckError?: (error: unknown) => void;
  readonly onDirtyChange: () => ((dirty: boolean) => void) | undefined;
}

export function createPreviewEditorController(options: PreviewEditorControllerOptions) {
  const state = $state({
    editing: false,
    draft: "",
    saving: false,
    checking: false,
    knowledgeResult: undefined as KnowledgeCheckResult | undefined,
    savedKnowledgeStamp: undefined as KnowledgeCheckStamp | undefined,
    savedKnowledgeReport: undefined as SavedKnowledgeReport | undefined,
  });
  let sourceId = options.previewId();
  let sourcePath = options.file()?.path;
  let sourceWorkspace = options.workspace?.() ?? "";
  let editGeneration = 0;
  let knowledgeGeneration = 0;
  let pendingCheck: PendingCheck | undefined;
  let pendingWrite: PendingWrite | undefined;
  let saveOwner: object | undefined;
  let reviewedDraft: DraftSnapshot | undefined;
  let reviewedCompleted = false;
  let stampSource: StampSource | undefined;
  let verifiedStampSource: StampSource | undefined;
  let savedReportSource: StampSource | undefined;
  let dismissedSavedReportSource = $state.raw<StampSource | undefined>();
  let invalidatedStampSource: StampSource | undefined;
  let dismissedKnowledgeJobId = $state<number | undefined>();
  let disposed = false;

  function matchingManualJobs(): readonly ProjectKnowledgeJob[] {
    const file = options.file();
    if (!file || file.virtualWikiDirectory || disposed || !/\.(md|markdown)$/iu.test(file.path)) return [];
    const workspace = options.workspace?.() ?? "";
    const content = state.editing ? state.draft : documentBody(file);
    return (options.knowledgeJobs?.() ?? []).filter((job) => job.workspace === workspace
      && job.path === file.path && job.content === content);
  }

  function manualJob(): ProjectKnowledgeJob | undefined {
    const stamp = state.savedKnowledgeStamp;
    const savedReport = state.savedKnowledgeReport;
    const job = matchingManualJobs().at(-1);
    const file = options.file();
    const finishedAt = job?.finishedAt ?? job?.createdAt ?? 0;
    const stampedAt = stamp ? Date.parse(stamp.checkedAt) : 0;
    // A later successful save of this same text supersedes its older manual
    // report. Keep that report in the project history without reviving it as
    // the current result when Preview is reopened. Exact raw-baseline matches
    // remain authoritative when removal of an old marker failed.
    if (job?.state === "completed" && stamp && verifiedStampSource
      && stampSourceIsCurrent(verifiedStampSource) && job.content === documentBody(file)
      && job.expectedContent !== file?.content
      && (finishedAt < stampedAt || (finishedAt === stampedAt && job.result?.status !== "clear"))) return undefined;
    // A newer persisted non-clear report also supersedes an older terminal
    // job, while an active or newly completed manual check keeps ownership.
    if (job?.state === "completed" && savedReport?.current && savedReportSource
      && stampSourceIsCurrent(savedReportSource) && savedReport.result.path === file?.path
      && job.content === documentBody(file) && job.expectedContent !== file?.content
      && finishedAt < Date.parse(savedReport.checkedAt)) return undefined;
    return job;
  }

  function visibleManualJob(): ProjectKnowledgeJob | undefined {
    const job = manualJob();
    return job?.id === dismissedKnowledgeJobId || job?.state === "cancelled" ? undefined : job;
  }

  function checking(): boolean {
    const job = visibleManualJob();
    return (state.checking && Boolean(pendingCheck && comparisonIsCurrent(pendingCheck.snapshot)))
      || job?.state === "queued" || job?.state === "running";
  }

  function knowledgeResult(): KnowledgeCheckResult | undefined {
    const localResult = state.knowledgeResult;
    if (reviewedDraft && comparisonIsCurrent(reviewedDraft) && localResult) return localResult;
    const job = visibleManualJob();
    if (job?.result) return job.result;
    if (job?.state === "failed") return {
      status: "incomplete", path: job.path, documentHash: "", modelRef: "", checkedSources: 0,
      conflicts: [], notices: [job.error ?? "The consistency check could not finish."],
    };
    return visibleSavedReport()?.result;
  }

  function visibleSavedReport(): SavedKnowledgeReport | undefined {
    const report = state.savedKnowledgeReport;
    if (!report || !savedReportSource || !stampSourceIsCurrent(savedReportSource)
      || savedReportSource === dismissedSavedReportSource) return undefined;
    return report;
  }

  function displayedSavedReport(): SavedKnowledgeReport | undefined {
    const report = visibleSavedReport();
    return report && knowledgeResult() === report.result ? report : undefined;
  }

  function knowledgeReportStale(): boolean {
    const report = displayedSavedReport();
    return Boolean(report && (!report.current || report.result.path !== options.file()?.path
      || (state.editing && state.draft !== documentBody(options.file()))));
  }

  function clearKnowledge(): void {
    if (saveOwner && pendingWrite?.savingOwner !== saveOwner) {
      saveOwner = undefined;
      state.saving = false;
    }
    knowledgeGeneration += 1;
    pendingCheck?.controller.abort();
    pendingCheck = undefined;
    reviewedDraft = undefined;
    reviewedCompleted = false;
    state.checking = false;
    state.knowledgeResult = undefined;
  }

  function updateDraft(content: string): void {
    if (content === state.draft) return;
    clearKnowledge();
    state.draft = content;
  }

  function snapshotIsCurrent(snapshot: DraftSnapshot): boolean {
    return !disposed && snapshot.editGeneration === editGeneration
      && options.previewId() === snapshot.previewId
      && (options.workspace?.() ?? "") === snapshot.workspace
      && options.file()?.path === snapshot.path;
  }

  function comparisonIsCurrent(snapshot: DraftSnapshot): boolean {
    const file = options.file();
    return snapshotIsCurrent(snapshot) && snapshot.knowledgeGeneration === knowledgeGeneration
      && state.editing === snapshot.editing
      && (snapshot.editing ? state.draft : documentBody(file)) === snapshot.content
      && (file?.content === snapshot.loadedContent
        || (pendingWrite?.snapshot === snapshot && file?.content === pendingWrite.content));
  }

  function captureDraft(): DraftSnapshot | undefined {
    const file = options.file();
    if (!file || disposed) return undefined;
    return {
      editGeneration, knowledgeGeneration, previewId: options.previewId(),
      workspace: options.workspace?.() ?? "", path: file.path, editing: state.editing,
      content: state.editing ? state.draft : documentBody(file), loadedContent: file.content,
    };
  }

  function canEdit(): boolean {
    return Boolean(
      !disposed && options.file()
      && options.editable()
      && options.onSaveProjectFile(),
    );
  }

  function dirty(): boolean {
    const file = options.file();
    return Boolean(state.editing && file && state.draft !== documentBody(file));
  }

  function stampSourceIsCurrent(source: StampSource): boolean {
    return !disposed && options.previewId() === source.previewId
      && (options.workspace?.() ?? "") === source.workspace
      && options.file()?.path === source.path && options.file()?.content === source.content;
  }

  function refreshSavedStamp(): void {
    const file = options.file();
    if (stampSource && stampSourceIsCurrent(stampSource)) return;
    stampSource = undefined;
    verifiedStampSource = undefined;
    savedReportSource = undefined;
    state.savedKnowledgeStamp = undefined;
    state.savedKnowledgeReport = undefined;
    if (!file || file.virtualWikiDirectory || !/\.(md|markdown)$/iu.test(file.path) || disposed) return;
    const owner: StampSource = { previewId: options.previewId(), workspace: options.workspace?.() ?? "", path: file.path, content: file.content };
    stampSource = owner;
    void Promise.all([readKnowledgeCheckStamp(file.content), readKnowledgeReport(file.content)]).then(([stamp, report]) => {
      if (stampSource !== owner || !stampSourceIsCurrent(owner)) return;
      state.savedKnowledgeStamp = stamp;
      verifiedStampSource = stamp ? owner : undefined;
      state.savedKnowledgeReport = report;
      savedReportSource = report ? owner : undefined;
    }).catch(error => {
      if (stampSource === owner && stampSourceIsCurrent(owner)) options.onKnowledgeCheckError?.(error);
    });
  }

  function synchronizeSource(): void {
    const id = options.previewId();
    const file = options.file();
    const content = file?.content ?? "";
    const workspace = options.workspace?.() ?? "";
    untrack(() => {
      if (sourceId !== id || sourcePath !== file?.path || sourceWorkspace !== workspace) {
        editGeneration += 1;
        clearKnowledge();
        pendingWrite = undefined;
        sourceId = id;
        sourcePath = file?.path;
        sourceWorkspace = workspace;
        state.editing = false;
        state.saving = false;
        dismissedKnowledgeJobId = undefined;
        dismissedSavedReportSource = undefined;
      }
      const ownWrite = pendingWrite && snapshotIsCurrent(pendingWrite.snapshot) && pendingWrite.content === content;
      if (!ownWrite && ((pendingCheck && pendingCheck.snapshot.loadedContent !== content)
        || (reviewedDraft && reviewedDraft.loadedContent !== content))) clearKnowledge();
      // A save updates the loaded file before its promise settles. Keep text
      // typed during that write instead of replacing it with the saved snapshot.
      if (!state.editing) state.draft = documentBody(file);
      if (invalidatedStampSource && !stampSourceIsCurrent(invalidatedStampSource)) invalidatedStampSource = undefined;
      refreshSavedStamp();
    });
  }

  $effect(synchronizeSource);
  $effect(() => () => { dispose(); });

  // Guard direct bindings as well as updateDraft(); completion checks also
  // compare the text synchronously, before any write can start.
  $effect(() => {
    const draft = state.draft;
    untrack(() => {
      if ((pendingCheck?.snapshot.editing && pendingCheck.snapshot.content !== draft)
        || (reviewedDraft?.editing && reviewedDraft.content !== draft)) clearKnowledge();
    });
  });

  $effect(() => {
    options.onDirtyChange()?.(dirty());
  });

  function begin(): void {
    if (disposed) return;
    synchronizeSource();
    editGeneration += 1;
    clearKnowledge();
    state.saving = false;
    state.draft = documentBody(options.file());
    state.editing = true;
  }

  function cancel(): void {
    editGeneration += 1;
    clearKnowledge();
    state.saving = false;
    state.draft = documentBody(options.file());
    state.editing = false;
  }

  function recordFailure(snapshot: DraftSnapshot, error: unknown, recording = false): KnowledgeCheckResult {
    options.onKnowledgeCheckError?.(error);
    const previous = state.knowledgeResult;
    const russian = previous?.reportLanguage === "ru";
    const notice = recording
      ? russian ? "Не удалось сохранить отметку проверки. Откройте документ заново и повторите проверку."
        : "The consistency check could not be recorded. Reload this document and check again."
      : "The consistency check could not finish. Try again, or choose Save anyway to save without a completed check.";
    const result: KnowledgeCheckResult = recording && previous ? {
      ...previous, status: previous.status === "clear" ? "incomplete" : previous.status,
      notices: [...previous.notices, notice],
    } : {
      status: "incomplete", path: snapshot.path, documentHash: "", modelRef: "",
      checkedSources: 0, conflicts: [], notices: [notice],
    };
    state.knowledgeResult = result;
    reviewedDraft = snapshot;
    if (!recording) reviewedCompleted = false;
    return result;
  }

  async function writeDraft(snapshot: DraftSnapshot, result?: KnowledgeCheckResult): Promise<void> {
    const saveFile = options.onSaveProjectFile();
    if (!saveFile || !canEdit() || !comparisonIsCurrent(snapshot) || state.saving || (snapshot.editing && !dirty())) return;
    const checkedWrite = Boolean(result || (reviewedDraft === snapshot && state.knowledgeResult));
    // Only a completed check owned by this exact draft may be persisted by
    // Save anyway. A report restored from disk never grants this permission.
    const reviewedResult = state.knowledgeResult;
    const recordedResult = result ?? (reviewedDraft === snapshot && reviewedCompleted
      && reviewedResult && /^[0-9a-f]{64}$/u.test(reviewedResult.documentHash) ? reviewedResult : undefined);
    const savingOwner = {};
    saveOwner = savingOwner;
    state.saving = true;
    let owner: PendingWrite | undefined;
    try {
      const content = recordedResult
        ? await recordKnowledgeCheck(snapshot.content, recordedResult, new Date(), snapshot.loadedContent)
        : /\.(md|markdown)$/iu.test(snapshot.path)
          ? snapshot.loadedContent.includes(KNOWLEDGE_REPORT_PREFIX)
            ? await preserveKnowledgeReport(snapshot.content, snapshot.loadedContent)
            : stripKnowledgeCheckStamp(snapshot.content)
          : snapshot.content;
      // Hashing is asynchronous: cancellation, typing, navigation or a newer
      // check must be observed again before invoking the compare-and-swap save.
      if (!canEdit() || !comparisonIsCurrent(snapshot) || saveOwner !== savingOwner) return;
      if (!snapshot.editing && content === snapshot.loadedContent) return;
      owner = { snapshot, content, savingOwner };
      pendingWrite = owner;
      if (!recordedResult) clearKnowledge();
      const authorizedGeneration = knowledgeGeneration;
      const guard: ProjectFileSaveGuard = {
        expectedContent: snapshot.loadedContent,
        isCurrent: () => pendingWrite === owner && saveOwner === savingOwner && canEdit()
          && snapshotIsCurrent(snapshot) && knowledgeGeneration === authorizedGeneration
          && state.editing === snapshot.editing
          && (snapshot.editing ? state.draft : documentBody(options.file())) === snapshot.content
          && options.file()?.content === snapshot.loadedContent,
      };
      const saved = checkedWrite ? await saveFile(snapshot.path, content, guard) : await saveFile(snapshot.path, content);
      if (!saved) {
        if (recordedResult && comparisonIsCurrent(snapshot)) recordFailure(snapshot, new Error("Could not persist the Wiki check result."), true);
        else synchronizeSource();
        return;
      }
      if (snapshotIsCurrent(snapshot) && state.editing === snapshot.editing
        && (snapshot.editing ? state.draft : documentBody(options.file())) === snapshot.content) {
        if (snapshot.editing) state.editing = false;
        if (recordedResult && knowledgeGeneration === snapshot.knowledgeGeneration && reviewedDraft === snapshot) {
          reviewedDraft = { ...snapshot, editing: false, loadedContent: content };
        }
      }
      synchronizeSource();
    } catch (error) {
      if (recordedResult && comparisonIsCurrent(snapshot)) recordFailure(snapshot, error, true);
      else if (!recordedResult && snapshotIsCurrent(snapshot)) throw error;
    } finally {
      if (pendingWrite === owner) pendingWrite = undefined;
      if (saveOwner === savingOwner) {
        saveOwner = undefined;
        state.saving = false;
      }
    }
  }

  async function runCheck(snapshot: DraftSnapshot, check: KnowledgeCheck): Promise<KnowledgeCheckResult | undefined> {
    const owner: PendingCheck = { snapshot, controller: new AbortController() };
    pendingCheck = owner;
    state.checking = true;
    try {
      const result = await requestCheck(check, snapshot, owner.controller.signal);
      if (!comparisonIsCurrent(snapshot) || pendingCheck !== owner) return undefined;
      if (result && result.path !== snapshot.path) throw new Error("The consistency result belongs to another document.");
      state.knowledgeResult = result;
      reviewedDraft = result ? snapshot : undefined;
      reviewedCompleted = Boolean(result);
      if (result && !snapshot.editing && result.status !== "clear") {
        invalidatedStampSource = { previewId: snapshot.previewId, workspace: snapshot.workspace, path: snapshot.path, content: snapshot.loadedContent };
      }
      return result;
    } catch (error) {
      if (owner.controller.signal.aborted || !comparisonIsCurrent(snapshot) || pendingCheck !== owner) return undefined;
      return recordFailure(snapshot, error);
    } finally {
      if (pendingCheck === owner) {
        pendingCheck = undefined;
        state.checking = false;
      }
    }
  }

  async function check(): Promise<void> {
    synchronizeSource();
    const checkKnowledge = options.onCheckKnowledge?.(), file = options.file();
    const enqueue = options.onEnqueueKnowledgeCheck?.();
    if (!file || file.virtualWikiDirectory || !/\.(md|markdown)$/iu.test(file.path)
      || disposed || (!checkKnowledge && !enqueue) || state.saving || checking()) return;
    clearKnowledge();
    const snapshot = captureDraft();
    if (!snapshot) return;
    if (enqueue) {
      try {
        const id = enqueue({ path: snapshot.path, content: snapshot.content,
          expectedContent: snapshot.loadedContent, persistStamp: !snapshot.editing && canEdit() });
        if (id === undefined) throw new Error("The check could not be queued. Wait for a running check to finish and try again.");
        dismissedKnowledgeJobId = undefined;
      } catch (error) { recordFailure(snapshot, error); }
      return;
    }
    if (!checkKnowledge) return;
    const result = await runCheck(snapshot, checkKnowledge);
    // In Edit the check is advisory until Save. Preview checks only the saved
    // body, so a completed result may update its in-file metadata immediately.
    if (!snapshot.editing && result && reviewedCompleted && comparisonIsCurrent(snapshot)) await writeDraft(snapshot, result);
  }

  async function save(): Promise<void> {
    synchronizeSource();
    if (!canEdit() || state.saving || checking() || !dirty()) return;
    editGeneration += 1;
    clearKnowledge();
    const snapshot = captureDraft();
    if (!snapshot) return;
    const checkKnowledge = options.onCheckKnowledge?.();
    let result: KnowledgeCheckResult | undefined;
    if (checkKnowledge) {
      result = await runCheck(snapshot, checkKnowledge);
      if (!comparisonIsCurrent(snapshot) || (result && result.status !== "clear")) return;
    }
    await writeDraft(snapshot, result);
  }

  function cancelCheck(): void {
    const job = visibleManualJob();
    // Only this explicit action cancels a project job. Navigation, editing and
    // controller teardown release local UI ownership without cancelling it.
    if (job?.state === "queued" || job?.state === "running") options.onCancelKnowledgeCheck?.()?.(job.id);
    if (job) dismissedKnowledgeJobId = job.id;
    dismissedSavedReportSource = stampSource;
    clearKnowledge();
  }

  function canSaveAnyway(): boolean {
    return Boolean(reviewedDraft?.editing && comparisonIsCurrent(reviewedDraft)
      && state.knowledgeResult && state.knowledgeResult.status !== "clear"
      && !state.saving && !state.checking && dirty());
  }

  async function saveAnyway(): Promise<void> {
    synchronizeSource();
    if (!canSaveAnyway() || !reviewedDraft) return;
    await writeDraft(reviewedDraft);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    editGeneration += 1;
    clearKnowledge();
    stampSource = verifiedStampSource = invalidatedStampSource = undefined;
    savedReportSource = dismissedSavedReportSource = undefined;
    saveOwner = undefined;
    state.savedKnowledgeStamp = undefined;
    state.savedKnowledgeReport = undefined;
    state.saving = false;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      cancel();
    }
  }

  async function canClose(): Promise<boolean> {
    if (!state.editing || !dirty()) return true;
    const generation = editGeneration;
    const preview = options.previewId(), path = options.file()?.path;
    const draft = state.draft;
    if (!await confirmDesktopAction("Discard unsaved changes?")) return false;
    return generation === editGeneration && preview === options.previewId()
      && path === options.file()?.path && state.editing && state.draft === draft;
  }

  synchronizeSource();
  return {
    state,
    get checking() { return checking(); },
    get queued() { return !state.checking && visibleManualJob()?.state === "queued"; },
    get knowledgeResult() { return knowledgeResult(); },
    get knowledgeReportStale() { return knowledgeReportStale(); },
    get knowledgeReportCheckedAt() { return displayedSavedReport()?.checkedAt; },
    get knowledgeRecordingError() {
      const job = visibleManualJob();
      return job?.state === "completed" ? job.error : undefined;
    },
    get canEdit() { return canEdit(); },
    get dirty() { return dirty(); },
    get savedKnowledgeStamp() {
      // Read reactive state before the ownership gates: initial verification and
      // a failed invalidation must also update an already-rendered badge.
      const stamp = state.savedKnowledgeStamp, result = state.knowledgeResult;
      if (dirty() || !verifiedStampSource || !stampSourceIsCurrent(verifiedStampSource)) return undefined;
      if (state.savedKnowledgeReport?.current && savedReportSource && stampSourceIsCurrent(savedReportSource)) return undefined;
      if (invalidatedStampSource && stampSourceIsCurrent(invalidatedStampSource)) return undefined;
      if (reviewedCompleted && reviewedDraft && comparisonIsCurrent(reviewedDraft) && result?.status !== "clear") return undefined;
      const completed = [...matchingManualJobs()].reverse().find((job) => job.state === "completed" && job.result);
      if (completed && completed.expectedContent === options.file()?.content
        && completed.result?.status && completed.result.status !== "clear") return undefined;
      return stamp;
    },
    get canSaveAnyway() { return canSaveAnyway(); },
    begin,
    cancel,
    updateDraft,
    check,
    cancelCheck,
    saveAnyway,
    dispose,
    save,
    handleKeydown,
    canClose,
  };
}
