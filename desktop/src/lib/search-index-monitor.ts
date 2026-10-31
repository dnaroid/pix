import type { SearchIndexStatus, SearchIndexActivity, SemanticConsent } from "./search-index-status";
import type { SourcePolicy } from "./search-source-selection";
import { createSearchIndexReadLane } from "./search-index-read-lane";
import type { SnapshotFreshnessRows } from "./search-index-freshness";

export interface SearchIndexSnapshot {
  stores: SearchIndexStatus | null;
  consent: SemanticConsent | null;
  activity: SearchIndexActivity | null;
  reading: boolean;
  storesCheckedAt?: number;
  error: string;
  consentError?: string;
  activityError?: string;
  selection?: SourcePolicy | null;
  selectionError?: string;
  freshness?: SnapshotFreshnessRows;
}

export function monitorSearchIndexes(options: {
  readStores(signal: AbortSignal): Promise<SearchIndexStatus>;
  readConsent(signal: AbortSignal): Promise<SemanticConsent>;
  readActivity?: (signal: AbortSignal) => Promise<SearchIndexActivity>;
  readSelection?: (signal: AbortSignal) => Promise<SourcePolicy>;
  readFreshness?: (signal: AbortSignal, force?: boolean) => Promise<SnapshotFreshnessRows>;
  onChange(snapshot: SearchIndexSnapshot): void;
  intervalMs?: number;
  activeIntervalMs?: number;
  readTimeoutMs?: number;
  /** Quiet polls reuse a successful selection read for this long. */
  selectionTtlMs?: number;
  isIndexing?: () => boolean;
}): { refresh(quiet?: boolean): Promise<void>; invalidateSelection(): void; dispose(): void } {
  const timeout = options.readTimeoutMs ?? 5000;
  const readStores = createSearchIndexReadLane(options.readStores, timeout);
  const readConsent = createSearchIndexReadLane(options.readConsent, timeout);
  const readActivity = options.readActivity && createSearchIndexReadLane(options.readActivity, timeout);
  const readSelection = options.readSelection && createSearchIndexReadLane(options.readSelection, timeout);
  // Each selection read spawns a native process. Selection changes are rare and
  // announced by events (the owner calls invalidateSelection), so quiet polls —
  // every 1.5 s while indexing — reuse the last successful read. The TTL picks
  // up external edits (CLI, editors) that do not raise Desktop events.
  const selectionTtl = options.selectionTtlMs ?? 60_000;
  let selectionEpoch = 0;
  let selectionReadAt: number | undefined;
  const invalidateSelection = () => { selectionEpoch++; selectionReadAt = undefined; };
  const selectionStale = (quiet: boolean) => !quiet || selectionReadAt === undefined
    || Date.now() - selectionReadAt >= selectionTtl;
  let forceFreshness = false;
  const readFreshness = options.readFreshness && createSearchIndexReadLane(signal => options.readFreshness!(signal, forceFreshness), timeout);
  let snapshot: SearchIndexSnapshot = { stores: null, consent: null, activity: null, reading: false, error: "" };
  let generation = 0;
  let disposed = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const publish = (change: Partial<SearchIndexSnapshot>) => {
    snapshot = { ...snapshot, ...change };
    options.onChange(snapshot);
  };
  async function refresh(quiet = false): Promise<void> {
    if (disposed) return;
    clearTimeout(timer);
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const request = ++generation;
    let freshnessFailed = false;
    const current = () => !disposed && request === generation;
    publish({ reading: !quiet });
    forceFreshness = !quiet;
    const epoch = selectionEpoch;
    const shouldReadSelection = readSelection && selectionStale(quiet);
    // Each status publishes independently. A slow ACP response cannot hide native counts.
    await Promise.all([
      readStores(signal).then(stores => { if (current()) publish({ stores, storesCheckedAt: Date.now(), error: "" }); })
        .catch(error => { if (current()) publish({ error: diagnosticReadError("Could not read index status", error) }); }),
      readConsent(signal).then(consent => { if (current()) publish({ consent, consentError: "" }); })
        .catch(() => { if (current()) publish({ consent: null, consentError: "Semantic settings could not be read" }); }),
      readActivity?.(signal).then(activity => { if (current()) publish({ activity, activityError: "" }); })
        .catch(error => { if (current()) publish({ activity: null,
          activityError: diagnosticReadError("Search activity could not be read", error) }); }),
      shouldReadSelection ? readSelection(signal).then(selection => {
        if (!current()) return;
        // A policy error is retried on the next poll; only a clean read is reused.
        if (epoch === selectionEpoch) selectionReadAt = selection.error ? undefined : Date.now();
        publish({ selection, selectionError: selection.error ?? "" });
      }).catch(() => {
        if (!current()) return;
        if (epoch === selectionEpoch) selectionReadAt = undefined;
        publish({ selection: null, selectionError: "Search source selection could not be read" });
      }) : undefined,
      readFreshness?.(signal).then(freshness => { if (current()) publish({ freshness }); })
        .catch(() => { freshnessFailed = true; if (current()) publish({ freshness: snapshot.freshness && Object.fromEntries(
          Object.entries(snapshot.freshness).map(([source, row]) => [source, { ...row,
            state: "unchecked", runState: undefined, detail: "Metadata check failed; retrying locally. Last-pass coverage is historical." }]),
        ) }); }),
    ]);
    if (!current()) return;
    publish({ reading: false });
    const active = options.isIndexing?.() || Object.values(snapshot.activity?.indexingSources ?? {}).some(Boolean);
    const interval = active ? options.activeIntervalMs ?? 1500 : options.intervalMs ?? 30000;
    const failed = freshnessFailed || snapshot.error || snapshot.consentError || snapshot.activityError || snapshot.selectionError
      || Object.entries(snapshot.freshness ?? {}).some(([source, row]) =>
        snapshot.selection?.enabled[source as keyof SourcePolicy["enabled"]] && row.state === "unchecked");
    failures = failed ? Math.min(failures + 1, 6) : 0;
    const delay = failures ? Math.min(interval, 1000 * 2 ** (failures - 1)) : interval;
    timer = setTimeout(() => void refresh(true), delay);
  }
  void refresh();
  return {
    refresh,
    invalidateSelection,
    dispose() { disposed = true; generation++; controller?.abort(); clearTimeout(timer); },
  };
}

function diagnosticReadError(label: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const detail = reason.replace(/[\r\n\t]+/g, " ").slice(0, 240).trim().replace(/[.!]+$/, "");
  return `${label}.${detail ? ` ${detail}.` : ""} Retrying automatically.`;
}
