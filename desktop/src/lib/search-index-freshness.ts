import type { IndexResult } from "./search-index-actions";
import type { SearchSourceId } from "./search-index-status";

export const SNAPSHOT_SOURCES: SearchSourceId[] = ["code", "knowledge", "settings", "sessions", "tasks", "commits"];
export type SnapshotObservation = { source?: string; index?: string; indexPresent?: boolean; matchesIndex?: boolean; checkedAt: number; error?: string };
export type SnapshotObservations = Partial<Record<SearchSourceId, SnapshotObservation>>;
export type SnapshotReceipt = { source: string; index: string; checkedAt: number; complete: boolean };
export type SnapshotFreshness = {
  state: "current" | "changed" | "unchecked" | "untracked" | "index-changed" | "index-changing";
  coverage: "complete" | "partial" | "unknown";
  checkedAt?: number;
  detail: string;
  runState?: string;
};
export type SnapshotFreshnessRows = Partial<Record<SearchSourceId, SnapshotFreshness>>;
type SnapshotIdentity = { source: string; index: string; checkedAt: number };
const valid = (value?: SnapshotObservation): value is SnapshotObservation & SnapshotIdentity => Boolean(value && !value.error
  && /^[a-f0-9]{64}$/.test(value.source ?? "") && /^[a-f0-9]{64}$/.test(value.index ?? "")
  && Number.isFinite(value.checkedAt));

export function snapshotFreshness(receipt?: SnapshotReceipt, observation?: SnapshotObservation, now = Date.now()): SnapshotFreshness {
  const coverage = receipt ? receipt.complete ? "complete" : "partial" : "unknown";
  const unchecked: SnapshotFreshness = { state: "unchecked", coverage, checkedAt: observation?.checkedAt,
    detail: "Metadata check unavailable or out of date. Retained counts and last-pass results are historical; checking retries locally without indexing." };
  if (observation?.error === "Index changed during check" && Number.isFinite(observation.checkedAt)
    && now - observation.checkedAt <= 120_000 && observation.checkedAt <= now) {
    return { ...unchecked, state: "index-changing",
      detail: "Index storage changed while metadata was being checked (writes or SQLite maintenance). A stable comparison is not available yet; retrying locally without indexing. Retained counts and last-pass coverage remain historical." };
  }
  if (!valid(observation) || now - observation.checkedAt > 120_000 || observation.checkedAt > now) return unchecked;
  if (observation.indexPresent && typeof observation.matchesIndex === "boolean") {
    return { state: observation.matchesIndex ? "current" : "changed", coverage, checkedAt: observation.checkedAt,
      detail: (observation.matchesIndex
        ? "Local source content matches the indexed file manifest. Unchanged file identities reuse published hashes; changed candidates are hashed locally."
        : "Local source content differs from the indexed file manifest. Run Index/Continue to refresh coverage.")
        + " This bounded check is not a content audit or proof of semantic coverage. Last-pass coverage remains historical." };
  }
  if (!receipt) return { ...unchecked, state: "untracked", detail: "Metadata read successfully. No recorded manual pass is available for comparison; this does not mean the cache is empty or search is broken." };
  if (receipt.source !== observation.source) return { state: "changed", coverage, checkedAt: observation.checkedAt,
    detail: "Source metadata or search configuration changed since the indexed snapshot. Run Index/Continue to refresh coverage." };
  if (receipt.index !== observation.index || observation.indexPresent === false) return { ...unchecked, state: "index-changed",
    detail: "Index storage changed since the recorded pass (including background writes or SQLite maintenance). Last-pass coverage is historical, not verification of the current cache." };
  return { state: "current", coverage, checkedAt: observation.checkedAt,
    detail: "No changes detected by the last local metadata check (not a content audit or a live guarantee). "
      + (receipt.complete ? "The last stable manual pass completed. This is historical coverage, not certification of later cache writes." : "The last stable manual pass was partial; Continue is needed.") };
}

/** Receipts contain only opaque digests/timestamps. Successful count reads and
 * background-idle observations can never manufacture a completion receipt. */
export function createSearchIndexFreshness(options: {
  workspace: string;
  probe(sources: SearchSourceId[], signal: AbortSignal): Promise<{ observations: SnapshotObservations;
    runs?: Partial<Record<SearchSourceId, { receipt?: SnapshotReceipt; state: string }>> }>;
  shared?: boolean;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const key = `pix.search-snapshot.v1:${options.workspace}`;
  let receipts: Partial<Record<SearchSourceId, SnapshotReceipt>> = {};
  let observations: SnapshotObservations = {};
  let lastRead = -Infinity;
  let retryAfter = 60_000;
  let epoch = 0;
  const revisions: Partial<Record<SearchSourceId, number>> = {};
  let runStates: Partial<Record<SearchSourceId, string>> = {};
  try {
    const saved = JSON.parse(options.storage?.getItem(key) ?? "null");
    for (const source of SNAPSHOT_SOURCES) {
      const candidate = saved?.[source], complete = candidate?.complete;
      if (valid(candidate) && typeof complete === "boolean") {
        receipts[source] = { source: candidate.source, index: candidate.index, checkedAt: candidate.checkedAt, complete };
      }
    }
  } catch { /* Storage unavailable/malformed means no receipt, not fresh. */ }
  const save = () => { try { options.storage?.setItem(key, JSON.stringify(receipts)); } catch { /* Memory remains usable. */ } };
  const rows = (): SnapshotFreshnessRows => Object.fromEntries(SNAPSHOT_SOURCES.map(source => {
    const row = snapshotFreshness(receipts[source], observations[source], now());
    return [source, { ...row, runState: runStates[source],
      detail: row.detail + (runStates[source] ? ` Shared manual run: ${runStates[source]}.` : "") }];
  }));
  const probe = async (sources: SearchSourceId[], signal: AbortSignal): Promise<SnapshotObservations> => {
    const startEpoch = epoch, versions = { ...revisions };
    try {
      const result = await options.probe(sources, signal);
      signal.throwIfAborted();
      if (options.shared && startEpoch === epoch) {
        for (const source of sources) {
          if (versions[source] !== revisions[source]) continue;
          const candidate = result.runs?.[source]?.receipt;
          if (valid(candidate) && typeof candidate?.complete === "boolean") receipts[source] = candidate;
          else delete receipts[source];
          const state = result.runs?.[source]?.state;
          runStates[source] = state && ["running", "stopping", "complete", "partial", "cancelled", "interrupted", "error"].includes(state) ? state : undefined;
        }
      }
      return result.observations ?? {};
    } catch {
      signal.throwIfAborted();
      // A failed read is not evidence that a persisted receipt was removed.
      if (startEpoch === epoch) runStates = {};
      return {};
    }
  };
  return {
    async read(signal: AbortSignal, force = false): Promise<SnapshotFreshnessRows> {
      if (!force && now() - lastRead < retryAfter) return rows();
      const startEpoch = epoch, versions = { ...revisions };
      const next = await probe(SNAPSHOT_SOURCES, signal);
      signal.throwIfAborted();
      if (startEpoch !== epoch) return rows();
      for (const source of SNAPSHOT_SOURCES) if (versions[source] === revisions[source]) observations[source] = next[source];
      retryAfter = Object.keys(next).length ? 60_000 : 5000;
      lastRead = now();
      return rows();
    },
    async run(source: SearchSourceId, signal: AbortSignal, run: () => Promise<IndexResult>): Promise<IndexResult> {
      const version = revisions[source] = (revisions[source] ?? 0) + 1;
      const startEpoch = epoch;
      delete receipts[source]; delete observations[source]; save();
      const before = (await probe([source], signal))[source];
      signal.throwIfAborted();
      const result = await run();
      signal.throwIfAborted();
      const after = (await probe([source], signal))[source];
      signal.throwIfAborted();
      if (startEpoch !== epoch || revisions[source] !== version) return result;
      revisions[source] = version + 1; // Fence status reads begun during this run.
      observations[source] = after;
      lastRead = -Infinity;
      if (result.source !== source || typeof result.complete !== "boolean") return result;
      if (valid(before) && valid(after) && before.source === after.source && after.indexPresent !== false) {
        receipts[source] = { source: after.source, index: after.index, checkedAt: after.checkedAt, complete: result.complete };
        save();
      } else if (valid(before) && valid(after) && before.source !== after.source) {
        receipts[source] = { source: before.source, index: after.index, checkedAt: before.checkedAt, complete: false };
        save();
        return { ...result, complete: false, message: "Source changed during indexing; snapshot coverage is unverified. Cached embeddings are retained; Continue to verify." };
      }
      return result;
    },
    invalidate() {
      epoch++; receipts = {}; observations = {}; runStates = {}; lastRead = -Infinity;
      try { options.storage?.removeItem(key); } catch { /* Best effort. */ }
    },
  };
}

export const SNAPSHOT_LABEL = { current: "Unchanged", changed: "Changed", unchecked: "Check unavailable", untracked: "No baseline", "index-changed": "Index changed", "index-changing": "Cache changing" };
