import type { SearchIndexStatus, SearchIndexActivity, SemanticConsent } from "./search-index-status";

export interface SearchIndexSnapshot {
  stores: SearchIndexStatus | null;
  consent: SemanticConsent | null;
  activity: SearchIndexActivity | null;
  reading: boolean;
  error: string;
  consentError?: string;
  activityError?: string;
}

export function monitorSearchIndexes(options: {
  readStores(signal: AbortSignal): Promise<SearchIndexStatus>;
  readConsent(signal: AbortSignal): Promise<SemanticConsent>;
  readActivity?: (signal: AbortSignal) => Promise<SearchIndexActivity>;
  onChange(snapshot: SearchIndexSnapshot): void;
  intervalMs?: number;
  activeIntervalMs?: number;
  isIndexing?: () => boolean;
}): { refresh(quiet?: boolean): Promise<void>; dispose(): void } {
  let snapshot: SearchIndexSnapshot = { stores: null, consent: null, activity: null, reading: false, error: "" };
  let generation = 0;
  let disposed = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
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
    const current = () => !disposed && request === generation;
    publish({ reading: !quiet });
    // Each status publishes independently. A slow ACP response cannot hide native counts.
    await Promise.all([
      options.readStores(signal).then(stores => { if (current()) publish({ stores, error: "" }); })
        .catch(() => { if (current()) publish({ stores: null, error: "Could not read index status. Try refreshing." }); }),
      options.readConsent(signal).then(consent => { if (current()) publish({ consent, consentError: "" }); })
        .catch(() => { if (current()) publish({ consent: null, consentError: "Semantic settings could not be read" }); }),
      options.readActivity?.(signal).then(activity => { if (current()) publish({ activity, activityError: "" }); })
        .catch(() => { if (current()) publish({ activity: null, activityError: "Search activity could not be read" }); }),
    ]);
    if (!current()) return;
    publish({ reading: false });
    const active = options.isIndexing?.() || Object.values(snapshot.activity?.indexingSources ?? {}).some(Boolean);
    timer = setTimeout(() => void refresh(true), active ? options.activeIntervalMs ?? 1500 : options.intervalMs ?? 30000);
  }
  void refresh();
  return {
    refresh,
    dispose() { disposed = true; generation++; controller?.abort(); clearTimeout(timer); },
  };
}
