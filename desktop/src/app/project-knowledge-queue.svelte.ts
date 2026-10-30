import { isKnowledgeCheckResult, MAX_KNOWLEDGE_DOCUMENT_CHARS, type KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import { MAX_KNOWLEDGE_STAMP_BYTES, MAX_KNOWLEDGE_REPORT_BYTES, stripKnowledgeCheckStamp } from "../../../acp/src/knowledge/stamp";
import { isWorkspaceProjectFilePath } from "../lib/project-files";

export interface ManualKnowledgeCheckInput {
  readonly path: string;
  readonly content: string;
  readonly expectedContent: string;
  /** Persist a success footer or a non-clear report block for the captured saved version. */
  readonly persistStamp: boolean;
}

export interface ProjectKnowledgeJob extends ManualKnowledgeCheckInput {
  readonly id: number;
  readonly workspace: string;
  readonly state: "queued" | "running" | "completed" | "failed" | "cancelled";
  readonly result?: KnowledgeCheckResult;
  readonly error?: string;
  readonly recorded?: boolean;
  readonly createdAt: number;
  readonly finishedAt?: number;
}

export const MAX_ACTIVE_KNOWLEDGE_JOBS = 16;
export const MAX_KNOWLEDGE_JOB_HISTORY = 32;

interface QueueOptions {
  readonly workspace: () => string;
  readonly check: (job: ProjectKnowledgeJob, signal: AbortSignal) => Promise<KnowledgeCheckResult | undefined>;
  readonly record: (job: ProjectKnowledgeJob, result: KnowledgeCheckResult, isCurrent: () => boolean) => Promise<boolean>;
  readonly reportError: (error: unknown) => void;
  readonly onComplete?: (job: ProjectKnowledgeJob) => void;
}

interface QueuedRun {
  readonly snapshot: ProjectKnowledgeJob;
  readonly controller: AbortController;
  readonly generation: number;
}

const active = (job: ProjectKnowledgeJob) => job.state === "queued" || job.state === "running";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function matchesSnapshot(result: KnowledgeCheckResult, content: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/u.test(result.documentHash)) return false;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return result.documentHash === hash;
}

/** Project-owned manual checks outlive Preview; no editor lifecycle owns their abort signal. */
export function createProjectKnowledgeQueue(options: QueueOptions) {
  let jobs = $state<readonly ProjectKnowledgeJob[]>([]);
  const pending = new Map<number, QueuedRun>();
  let running: QueuedRun | undefined;
  let generation = 0;
  let sequence = 0;

  function prune(): void {
    const history = jobs.filter(job => !active(job));
    if (history.length <= MAX_KNOWLEDGE_JOB_HISTORY) return;
    const expired = new Set(history.slice(0, history.length - MAX_KNOWLEDGE_JOB_HISTORY).map(job => job.id));
    jobs = jobs.filter(job => !expired.has(job.id));
  }

  function update(id: number, values: Partial<ProjectKnowledgeJob>): ProjectKnowledgeJob | undefined {
    let updated: ProjectKnowledgeJob | undefined;
    jobs = jobs.map(job => {
      if (job.id !== id) return job;
      updated = { ...job, ...values };
      return updated;
    });
    return updated;
  }

  function isCurrent(run: QueuedRun): boolean {
    return running === run && run.generation === generation
      && options.workspace() === run.snapshot.workspace && !run.controller.signal.aborted
      && jobs.some(job => job.id === run.snapshot.id && job.state === "running");
  }

  function notify(job: ProjectKnowledgeJob | undefined): void {
    if (!job || options.workspace() !== job.workspace) return;
    try { options.onComplete?.(job); }
    catch (error) { options.reportError(error); }
  }

  async function execute(run: QueuedRun): Promise<void> {
    try {
      const result = await options.check(run.snapshot, run.controller.signal);
      if (!isCurrent(run)) return;
      if (!result) throw new Error("This page is no longer inside the configured Wiki.");
      if (!isKnowledgeCheckResult(result) || result.path !== run.snapshot.path) {
        throw new Error("The consistency result belongs to another document or is invalid.");
      }
      if (!await matchesSnapshot(result, run.snapshot.content)) {
        throw new Error("The consistency result does not match the checked document snapshot.");
      }
      if (!isCurrent(run)) return;
      let recorded: boolean | undefined;
      let error: string | undefined;
      if (run.snapshot.persistStamp) {
        try {
          recorded = await options.record(run.snapshot, result, () => isCurrent(run));
          if (!recorded) error = result.reportLanguage === "ru"
            ? "Отчёт сохранён в очереди, но результат проверки не удалось записать в файл. Файл мог измениться; откройте его заново и повторите проверку."
            : "The report is retained in the queue, but the check result could not be saved in the file. The file may have changed; reopen it and check again.";
        } catch (cause) {
          if (!isCurrent(run)) return;
          recorded = false;
          error = message(cause);
          options.reportError(cause);
        }
      }
      if (!isCurrent(run)) return;
      const completed = update(run.snapshot.id, { state: "completed", result, recorded, error, finishedAt: Date.now() });
      prune();
      notify(completed);
    } catch (error) {
      if (!isCurrent(run)) return;
      options.reportError(error);
      const failed = update(run.snapshot.id, { state: "failed", error: message(error), finishedAt: Date.now() });
      prune();
      notify(failed);
    } finally {
      // Keep this physical slot until check/record actually settles, including
      // providers that ignore abort. Cancelling cannot start parallel model calls.
      if (jobs.some(job => job.id === run.snapshot.id && job.state === "running")) {
        update(run.snapshot.id, { state: "cancelled", finishedAt: Date.now() });
      }
      pending.delete(run.snapshot.id);
      if (running === run) running = undefined;
      queueMicrotask(pump);
    }
  }

  function pump(): void {
    if (running) return;
    for (const job of jobs) {
      if (job.state !== "queued") continue;
      const run = pending.get(job.id);
      if (!run || run.generation !== generation || options.workspace() !== job.workspace) {
        update(job.id, { state: "cancelled", finishedAt: Date.now() });
        pending.delete(job.id);
        continue;
      }
      running = run;
      update(job.id, { state: "running" });
      void execute(run);
      return;
    }
    prune();
  }

  function enqueue(input: ManualKnowledgeCheckInput): number | undefined {
    const workspace = options.workspace();
    const content = stripKnowledgeCheckStamp(input.content);
    if (!workspace || !isWorkspaceProjectFilePath(input.path) || !/\.(md|markdown)$/iu.test(input.path)) return undefined;
    if (content.length > MAX_KNOWLEDGE_DOCUMENT_CHARS
      || input.expectedContent.length > MAX_KNOWLEDGE_DOCUMENT_CHARS + MAX_KNOWLEDGE_STAMP_BYTES + MAX_KNOWLEDGE_REPORT_BYTES) {
      options.reportError(new Error("This document is too large for a queued Wiki check."));
      return undefined;
    }
    if (input.persistStamp && stripKnowledgeCheckStamp(input.expectedContent) !== content) {
      options.reportError(new Error("A saved-page check must match the loaded document. Check the edited draft without saving its marker."));
      return undefined;
    }
    const duplicate = jobs.find(job => active(job) && job.workspace === workspace && job.path === input.path
      && job.content === content && job.expectedContent === input.expectedContent && job.persistStamp === input.persistStamp);
    if (duplicate) return duplicate.id;
    if (jobs.filter(active).length >= MAX_ACTIVE_KNOWLEDGE_JOBS) {
      options.reportError(new Error("The Wiki check queue is full. Wait for a check to finish or cancel a queued check."));
      return undefined;
    }
    const snapshot: ProjectKnowledgeJob = {
      id: ++sequence, workspace, path: input.path, content,
      expectedContent: input.expectedContent, persistStamp: input.persistStamp,
      state: "queued", createdAt: Date.now(),
    };
    pending.set(snapshot.id, { snapshot, controller: new AbortController(), generation });
    jobs = [...jobs, snapshot];
    prune();
    queueMicrotask(pump);
    return snapshot.id;
  }

  function cancel(id: number): void {
    const job = jobs.find(job => job.id === id);
    if (!job || !active(job)) return;
    update(id, { state: "cancelled", finishedAt: Date.now() });
    const run = pending.get(id);
    run?.controller.abort(new Error("Wiki check cancelled."));
    if (run !== running) pending.delete(id);
    prune();
    queueMicrotask(pump);
  }

  function reset(): void {
    generation++;
    for (const run of pending.values()) run.controller.abort(new Error("Project Wiki checks were reset."));
    pending.clear();
    jobs = [];
    // A previously started call still owns `running` until its physical promise
    // settles. Its generation fence prevents writes, reports and notifications.
  }

  return {
    get jobs() { return jobs; },
    enqueue,
    cancel,
    dismiss(id: number): void {
      jobs = jobs.filter(job => job.id !== id || active(job));
    },
    find(path: string, content: string): ProjectKnowledgeJob | undefined {
      const body = stripKnowledgeCheckStamp(content);
      return [...jobs].reverse().find(job => job.workspace === options.workspace()
        && job.path === path && job.content === body);
    },
    reset,
  };
}
