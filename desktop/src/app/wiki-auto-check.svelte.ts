import { MAX_KNOWLEDGE_CHUNK_CHARS, MAX_KNOWLEDGE_DOCUMENT_CHARS } from "../../../acp/src/knowledge/contract";
import {
  MAX_KNOWLEDGE_REPORT_BYTES, MAX_KNOWLEDGE_STAMP_BYTES,
  readKnowledgeAutoCheckAttempt, readKnowledgeCheckStamp, stripKnowledgeCheckStamp,
} from "../../../acp/src/knowledge/stamp";
import type { WikiAutoCheckView } from "../lib/wiki-auto-check-config";
import {
  MAX_ACTIVE_KNOWLEDGE_JOBS, type ManualKnowledgeCheckInput, type ProjectKnowledgeJob,
} from "./project-knowledge-queue.svelte";

export const WIKI_AUTO_CHECK_POLL_MS = 5_000;
export const WIKI_AUTO_CHECK_SETTLE_MS = 750;
export const MAX_WIKI_AUTO_CHECK_FILES = 50_000;
export const MAX_WIKI_AUTO_CHECK_RAW_BYTES = MAX_KNOWLEDGE_DOCUMENT_CHARS * 4
  + MAX_KNOWLEDGE_REPORT_BYTES + MAX_KNOWLEDGE_STAMP_BYTES;
const WORK_SLICE_MS = 50;
const PAGES_PER_SLICE = 4;
const READS_PER_SLICE = 4;

export interface WikiAutoCheckConfiguration {
  readonly enabled: boolean;
  readonly wikiPath: string;
  readonly runId?: string;
  readonly sourcesEnabled?: boolean;
}

export interface WikiCheckInventoryEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly revision?: string;
  readonly size?: number;
}

export interface WikiCheckInventoryPage {
  readonly entries: readonly WikiCheckInventoryEntry[];
  readonly nextCursor?: string;
}

export interface WikiCheckInventoryRequest {
  readonly workspace: string;
  readonly wikiPath: string;
  readonly path: string;
  readonly cursor?: string;
}

export interface SkippedWikiAutoCheck {
  readonly workspace: string;
  readonly path: string;
  readonly content: string;
  readonly contentHash: string;
  readonly runId: string;
}

interface SchedulerOptions {
  readonly workspace: () => string;
  readonly readConfig: (workspace: string, signal: AbortSignal) => Promise<WikiAutoCheckConfiguration>;
  readonly listDirectory: (request: WikiCheckInventoryRequest, signal: AbortSignal) => Promise<WikiCheckInventoryPage>;
  readonly releaseInventory: (workspace: string, cursor: string) => Promise<void>;
  readonly readFile: (workspace: string, wikiPath: string, path: string, signal: AbortSignal) => Promise<{ readonly path: string; readonly content: string }>;
  readonly jobs: () => readonly ProjectKnowledgeJob[];
  readonly enqueue: (input: ManualKnowledgeCheckInput) => number | undefined;
  readonly cancel: (id: number) => void;
  readonly cancelQueuedBackground: () => void;
  readonly ready?: () => boolean;
  readonly recordSkipped?: (input: SkippedWikiAutoCheck, isCurrent: () => boolean) => Promise<boolean>;
  /** Diagnostics only: never a completion toast or modal for background work. */
  readonly reportError: (error: unknown) => void;
  /** A smaller deterministic-test budget may not raise the production cap. */
  readonly inventoryLimit?: number;
}

interface Owner { readonly workspace: string; readonly wikiPath: string; readonly runId: string; }
interface Observation {
  readonly path: string;
  revision: string;
  size: number;
  stableAt: number;
  seen: number;
  checkedRevision?: string;
  hash?: string;
  processedHash?: string;
  jobId?: number;
  jobHash?: string;
  eligible: boolean;
  phase: "unknown" | "waiting" | "active" | "done" | "green" | "skipped";
}
interface Scan {
  readonly id: number; readonly directories: string[];
  readonly reclaim: IterableIterator<[string, Observation]>;
  index: number; cursor?: string;
}

const activeJob = (job: ProjectKnowledgeJob) => job.state === "queued" || job.state === "running";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 600);

function safePath(path: string): boolean {
  return !!path && !/[\\\u0000-\u001f\u007f:]/u.test(path)
    && path.split("/").every(part => !!part && part !== "." && part !== "..");
}

async function hashBody(content: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** One project-owned metadata poller; file bodies live only in a bounded read or the shared queue. */
export function createWikiAutoCheckScheduler(options: SchedulerOptions) {
  let state = $state<Omit<WikiAutoCheckView, "saving">>({
    enabled: false, scanning: false, completed: 0, total: 0, queued: 0, running: false,
  });
  const observations = new Map<string, Observation>();
  const inventoryLimit = Number.isSafeInteger(options.inventoryLimit) && options.inventoryLimit! > 0
    ? Math.min(options.inventoryLimit!, MAX_WIKI_AUTO_CHECK_FILES) : MAX_WIKI_AUTO_CHECK_FILES;
  // Work sets avoid rescanning a large Wiki for every small processing slice.
  const unread = new Set<string>(), waiting = new Set<string>(), tracked = new Set<string>();
  let eligibleCount = 0, completedCount = 0, activeCount = 0;
  const loggedErrors = new Set<string>();
  let owner: Owner | undefined;
  let scan: Scan | undefined;
  let scanSequence = 0;
  let scanIssue: string | undefined;
  let generation = 0;
  let started = false;
  let disposed = false;
  let busy = false;
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = 0;
  let nextConfigAt = 0;
  let nextScanAt = 0;
  let boundWorkspace = "";
  let sourcesEnabled = true;

  function report(error: unknown): void {
    const message = errorText(error);
    state = { ...state, error: message };
    if (loggedErrors.has(message)) return;
    if (loggedErrors.size >= 32) loggedErrors.delete(loggedErrors.values().next().value!);
    loggedErrors.add(message);
    options.reportError(error);
  }

  function release(workspace: string, cursor: string | undefined, scope = owner): void {
    if (!cursor) return;
    const issuedGeneration = generation;
    void options.releaseInventory(workspace, cursor).catch(error => {
      if (!disposed && generation === issuedGeneration && owner === scope && options.workspace() === workspace) report(error);
    });
  }

  function abandonScan(): void {
    if (owner) release(owner.workspace, scan?.cursor);
    scan = undefined;
  }

  const completedPhase = (phase: Observation["phase"]) => phase === "done" || phase === "skipped";

  function phase(item: Observation, next: Observation["phase"], eligible = item.eligible): void {
    if (item.eligible) {
      eligibleCount--;
      if (completedPhase(item.phase)) completedCount--;
      if (item.phase === "active") activeCount--;
    }
    item.phase = next; item.eligible = eligible;
    waiting.delete(item.path);
    if (eligible) {
      eligibleCount++;
      if (completedPhase(next)) completedCount++;
      if (next === "active") activeCount++;
      if (next === "waiting") waiting.add(item.path);
    }
  }

  function clearJob(item: Observation): void {
    tracked.delete(item.path); item.jobId = undefined; item.jobHash = undefined;
  }

  function track(item: Observation, id: number, hash: string): void {
    item.jobId = id; item.jobHash = hash; tracked.add(item.path); phase(item, "active", true);
  }

  function publish(): void {
    const enabled = !!owner, scanning = !!scan || unread.size > 0, queued = waiting.size + activeCount;
    if (state.enabled !== enabled || state.scanning !== scanning || state.total !== eligibleCount
      || state.completed !== completedCount || state.queued !== queued) {
      state = { ...state, enabled, scanning, total: eligibleCount, completed: completedCount, queued, running: false };
    }
  }

  function schedule(delay: number): void {
    if (!started || disposed) return;
    const at = Date.now() + Math.max(0, delay);
    if (timer !== undefined && timerAt <= at) return;
    if (timer !== undefined) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => { timer = undefined; void tick(); }, Math.max(0, at - Date.now()));
  }

  function clearOwner(): void {
    abandonScan();
    options.cancelQueuedBackground();
    owner = undefined;
    observations.clear(); unread.clear(); waiting.clear(); tracked.clear();
    eligibleCount = 0; completedCount = 0; activeCount = 0; scanIssue = undefined;
    loggedErrors.clear();
    state = { enabled: false, scanning: false, completed: 0, total: 0, queued: 0, running: false };
  }

  function configure(workspace: string, config: WikiAutoCheckConfiguration): void {
    const previousSources = sourcesEnabled;
    sourcesEnabled = config.sourcesEnabled !== false;
    if (!sourcesEnabled) {
      for (const path of tracked) { const item = observations.get(path); if (item) cancelWaiting(item); }
      options.cancelQueuedBackground();
    }
    else if (!previousSources) { nextScanAt = 0; state = { ...state, error: undefined }; }
    if (!config.enabled) { if (owner) clearOwner(); return; }
    if (!safePath(config.wikiPath) || !config.runId || config.runId.length > 128 || /[\u0000-\u001f\u007f]/u.test(config.runId)) {
      clearOwner();
      throw new Error("Automatic Wiki checks need a valid Wiki directory and a saved pass identity.");
    }
    if (owner?.workspace === workspace && owner.wikiPath === config.wikiPath && owner.runId === config.runId) return;
    clearOwner();
    owner = { workspace, wikiPath: config.wikiPath, runId: config.runId };
    nextScanAt = 0;
    publish();
  }

  function cancelWaiting(item: Observation): void {
    const job = options.jobs().find(job => job.id === item.jobId);
    if (job?.origin === "background" && job.state === "queued") {
      options.cancel(job.id);
      clearJob(item); phase(item, item.eligible ? "waiting" : "unknown");
    }
  }

  function forget(path: string, item: Observation): void {
    // Forgetting inventory never aborts a running judge. The project queue still
    // owns that request and its guarded write; only waiting automatic work stops.
    cancelWaiting(item); phase(item, "unknown", false); clearJob(item); unread.delete(path);
    observations.delete(path);
  }

  function reclaimUnseen(currentScan: Scan): boolean {
    for (let entry = currentScan.reclaim.next(); !entry.done; entry = currentScan.reclaim.next()) {
      const [path, item] = entry.value;
      if (observations.get(path) !== item || item.seen === currentScan.id) continue;
      forget(path, item);
      return true;
    }
    return false;
  }

  function observe(entry: WikiCheckInventoryEntry, currentScan: Scan): void {
    const previous = observations.get(entry.path);
    if (previous) {
      previous.seen = currentScan.id;
      if (previous.revision !== entry.revision) {
        cancelWaiting(previous);
        previous.revision = entry.revision!;
        previous.size = entry.size!;
        previous.stableAt = Date.now() + WIKI_AUTO_CHECK_SETTLE_MS;
        previous.checkedRevision = undefined;
        unread.delete(previous.path); unread.add(previous.path); waiting.delete(previous.path);
      }
      return;
    }
    if (observations.size >= inventoryLimit && !reclaimUnseen(currentScan)) {
      throw new Error(`Automatic Wiki inventory reached its ${inventoryLimit}-file limit.`);
    }
    observations.set(entry.path, { path: entry.path, revision: entry.revision!, size: entry.size!,
      stableAt: Date.now() + WIKI_AUTO_CHECK_SETTLE_MS, seen: currentScan.id, eligible: false, phase: "unknown" });
    unread.add(entry.path);
  }

  async function scanSlice(currentOwner: Owner, signal: AbortSignal, live: () => boolean): Promise<void> {
    if (!scan && Date.now() >= nextScanAt) scan = { id: ++scanSequence, directories: [currentOwner.wikiPath], index: 0, reclaim: observations.entries() };
    for (let count = 0; count < PAGES_PER_SLICE && scan && live(); count++) {
      const currentScan = scan;
      const path = currentScan.directories[currentScan.index]!;
      // A cursor is consumed by each native call. Only the returned cursor may
      // be released or reused, including when this reply belongs to an old owner.
      const cursor = currentScan.cursor;
      currentScan.cursor = undefined;
      let page: WikiCheckInventoryPage;
      try {
        page = await options.listDirectory({ workspace: currentOwner.workspace, wikiPath: currentOwner.wikiPath, path,
          ...(cursor ? { cursor } : {}) }, signal);
      } catch (error) {
        if (!live()) return;
        scan = undefined;
        nextScanAt = Date.now() + WIKI_AUTO_CHECK_POLL_MS;
        scanIssue = errorText(error); report(error);
        return;
      }
      if (!live() || scan !== currentScan) { release(currentOwner.workspace, page.nextCursor, currentOwner); return; }
      currentScan.cursor = page.nextCursor;
      try {
        if (page.entries.length > 128) throw new Error("The Wiki inventory returned an oversized page.");
        for (const entry of page.entries) {
          if (!safePath(entry.path) || !entry.path.startsWith(currentOwner.wikiPath + "/")
            || entry.path.slice(0, entry.path.lastIndexOf("/")) !== path) throw new Error("The Wiki inventory returned a path outside its directory.");
          if (entry.kind === "directory") {
            if (currentScan.directories.length >= MAX_WIKI_AUTO_CHECK_FILES) throw new Error("Automatic Wiki inventory reached its directory limit.");
            currentScan.directories.push(entry.path);
          } else {
            if (!/\.(md|markdown)$/iu.test(entry.path) || !entry.revision || entry.revision.length > 256
              || !Number.isSafeInteger(entry.size) || entry.size! < 0) throw new Error("The Wiki inventory returned invalid file metadata.");
            observe(entry, currentScan);
          }
        }
        if (!page.nextCursor) currentScan.index++;
        if (currentScan.index >= currentScan.directories.length) {
          for (const [path, item] of observations) {
            if (item.seen !== currentScan.id) forget(path, item);
          }
          scan = undefined;
          nextScanAt = Date.now() + WIKI_AUTO_CHECK_POLL_MS;
          if (scanIssue && state.error === scanIssue) state = { ...state, error: undefined };
          scanIssue = undefined;
        }
      } catch (error) {
        abandonScan();
        nextScanAt = Date.now() + WIKI_AUTO_CHECK_POLL_MS;
        scanIssue = errorText(error); report(error);
        return;
      }
    }
  }

  function reconcileJobs(): void {
    for (const path of tracked) {
      const item = observations.get(path);
      if (!item) { tracked.delete(path); continue; }
      const job = options.jobs().find(job => job.id === item.jobId);
      if (job && activeJob(job)) continue;
      // Explicit cancellation is terminal for this version/pass. An observed
      // edit or policy pause clears the queued association before reconciliation.
      item.processedHash = item.jobHash;
      clearJob(item);
      phase(item, item.hash === item.processedHash ? "done" : "waiting");
      if (unread.has(item.path)) waiting.delete(item.path);
    }
  }

  function hasRoom(): boolean {
    const active = options.jobs().filter(activeJob);
    return sourcesEnabled && (options.ready?.() ?? true) && active.length < MAX_ACTIVE_KNOWLEDGE_JOBS - 1
      && !active.some(job => job.origin === "background" || !!job.autoCheckRunId);
  }

  async function inspect(item: Observation, currentOwner: Owner, signal: AbortSignal, live: () => boolean): Promise<void> {
    const revision = item.revision;
    const current = () => live() && observations.get(item.path) === item && item.revision === revision;
    item.checkedRevision = revision;
    if (item.size > MAX_WIKI_AUTO_CHECK_RAW_BYTES) {
      phase(item, "skipped", true);
      report(new Error(`Wiki page is too large for an automatic check: ${item.path}`));
      return;
    }
    try {
      const file = await options.readFile(currentOwner.workspace, currentOwner.wikiPath, item.path, signal);
      if (!current()) return;
      if (file.path !== item.path || new TextEncoder().encode(file.content).byteLength > MAX_WIKI_AUTO_CHECK_RAW_BYTES) {
        throw new Error("The Wiki reader returned a different or oversized saved document.");
      }
      const body = stripKnowledgeCheckStamp(file.content);
      const [stamp, attempt, hash] = await Promise.all([
        readKnowledgeCheckStamp(file.content), readKnowledgeAutoCheckAttempt(file.content), hashBody(body),
      ]);
      if (!current()) return;
      item.hash = hash;
      if (stamp) {
        cancelWaiting(item);
        item.processedHash = hash;
        clearJob(item); phase(item, item.eligible ? "done" : "green");
        return;
      }
      if ((attempt?.current && attempt.runId === currentOwner.runId
        && (attempt.maxDocumentChars ?? MAX_KNOWLEDGE_CHUNK_CHARS) >= Math.min(body.length, MAX_KNOWLEDGE_DOCUMENT_CHARS))
        || item.processedHash === hash) {
        item.processedHash = hash; clearJob(item); phase(item, "done", true);
        return;
      }
      if (body.length > MAX_KNOWLEDGE_DOCUMENT_CHARS) {
        item.processedHash = hash; clearJob(item); phase(item, "skipped", true);
        report(new Error(`Wiki page exceeds the ${MAX_KNOWLEDGE_DOCUMENT_CHARS.toLocaleString("en-US")}-character check limit: ${item.path}`));
        await options.recordSkipped?.({ workspace: currentOwner.workspace, path: item.path,
          content: file.content, contentHash: hash, runId: currentOwner.runId }, current);
        return;
      }
      const duplicate = options.jobs().find(job => activeJob(job) && job.workspace === currentOwner.workspace
        && job.path === item.path && job.persistStamp && job.content === body);
      if (duplicate) { track(item, duplicate.id, hash); return; }
      phase(item, "waiting", true);
      if (!hasRoom()) return;
      const id = options.enqueue({ path: item.path, content: body, expectedContent: file.content,
        persistStamp: true, origin: "background", autoCheckRunId: currentOwner.runId });
      if (id !== undefined) track(item, id, hash);
    } catch (error) {
      if (!current()) return;
      phase(item, "skipped", true);
      report(error);
    }
  }

  async function inspectSlice(currentOwner: Owner, signal: AbortSignal, live: () => boolean): Promise<void> {
    reconcileJobs();
    let count = 0;
    // An older eligible page gets the next available slot before newly discovered
    // pages. Its bytes are reread here instead of retained in the waiting set.
    if (hasRoom()) {
      for (const path of waiting) {
        const item = observations.get(path);
        if (!item || unread.has(path) || item.stableAt > Date.now()) continue;
        count++;
        await inspect(item, currentOwner, signal, live);
        break;
      }
    }
    while (live() && count < READS_PER_SLICE && unread.size > 0) {
      const path = unread.values().next().value!;
      const item = observations.get(path);
      if (!item) { unread.delete(path); continue; }
      // Insertion order follows the last observed edit, including reinsertions.
      if (item.stableAt > Date.now()) break;
      unread.delete(path); count++;
      await inspect(item, currentOwner, signal, live);
    }
  }

  function nextDelay(): number {
    if (!owner || !sourcesEnabled) return Math.max(0, nextConfigAt - Date.now());
    if (scan) return WORK_SLICE_MS;
    const now = Date.now();
    let delay = Math.min(nextConfigAt, nextScanAt) - now;
    const firstUnread = observations.get(unread.values().next().value ?? "");
    if (firstUnread) delay = Math.min(delay, Math.max(WORK_SLICE_MS, firstUnread.stableAt - now));
    if (waiting.size > 0 && hasRoom()) delay = Math.min(delay, WORK_SLICE_MS);
    return Math.max(WORK_SLICE_MS, delay);
  }

  async function tick(): Promise<void> {
    if (!started || disposed || busy) return;
    const workspace = options.workspace();
    if (!workspace || workspace !== boundWorkspace) { reset(); return; }
    busy = true;
    const ownedGeneration = generation;
    const controller = new AbortController();
    request = controller;
    const valid = () => started && !disposed && generation === ownedGeneration
      && options.workspace() === workspace && !controller.signal.aborted;
    try {
      if (Date.now() >= nextConfigAt) {
        nextConfigAt = Date.now() + WIKI_AUTO_CHECK_POLL_MS;
        try {
          const config = await options.readConfig(workspace, controller.signal);
          if (!valid()) return;
          configure(workspace, config);
        } catch (error) {
          if (!valid()) return;
          clearOwner(); report(error);
          return;
        }
      }
      const currentOwner = owner;
      if (!currentOwner || !valid()) return;
      if (!sourcesEnabled) {
        abandonScan();
        state = { ...state, enabled: true, scanning: false, error: "Источник Knowledge выключен. Автопроверка продолжится после его включения." };
        return;
      }
      const live = () => valid() && owner === currentOwner;
      await scanSlice(currentOwner, controller.signal, live);
      if (live()) await inspectSlice(currentOwner, controller.signal, live);
      if (live()) publish();
    } catch (error) {
      if (valid()) report(error);
    } finally {
      if (request === controller) request = undefined;
      busy = false;
      if (started && !disposed) schedule(valid() ? nextDelay() : 0);
    }
  }

  function reset(): void {
    started = false;
    generation++;
    request?.abort();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    clearOwner();
    nextConfigAt = 0; nextScanAt = 0; boundWorkspace = "";
  }

  return {
    get view(): Omit<WikiAutoCheckView, "saving"> {
      const runningJobs = options.jobs().filter(job => job.workspace === boundWorkspace && job.state === "running");
      const trackedRunning = runningJobs.filter(job => observations.get(job.path)?.jobId === job.id).length;
      const running = trackedRunning > 0 || runningJobs.some(job => job.origin === "background" || !!job.autoCheckRunId);
      return { ...state, running, queued: Math.max(0, state.queued - trackedRunning) };
    },
    start(): void {
      if (disposed) return;
      const workspace = options.workspace();
      if (!workspace) { reset(); return; }
      if (boundWorkspace !== workspace) reset();
      boundWorkspace = workspace; started = true;
      schedule(0);
    },
    refresh(): void { nextConfigAt = 0; nextScanAt = 0; schedule(0); },
    jobCompleted(job: ProjectKnowledgeJob): void {
      if (!owner || job.workspace !== owner.workspace || !job.persistStamp) return;
      const item = observations.get(job.path);
      if (!item) return;
      if (job.id !== item.jobId && (!job.result || job.result.documentHash !== item.hash)) return;
      item.processedHash = job.result?.documentHash ?? item.jobHash;
      clearJob(item);
      phase(item, item.hash === item.processedHash ? "done" : "waiting");
      if (unread.has(item.path)) waiting.delete(item.path);
      nextScanAt = 0;
      publish(); schedule(0);
    },
    reset,
    dispose(): void { reset(); disposed = true; },
  };
}
