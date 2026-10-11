import type { IndexActions } from "./search-index-actions";
import type { SearchIndexSnapshot } from "./search-index-monitor";
import type { SearchIndexHistory } from "./search-index-history";
import type { SearchSourceId } from "./search-index-status";

/** Observations are not provider receipts: becoming idle does not prove success. */
export function observeSearchIndexEvents(history: SearchIndexHistory, workspace: string) {
  let snapshot: SearchIndexSnapshot | undefined;
  let actions: IndexActions = {};
  const background = new Set<SearchSourceId>();
  const add = (source: Parameters<SearchIndexHistory["append"]>[1], level: Parameters<SearchIndexHistory["append"]>[2], message: string) =>
    history.append(workspace, source, level, message);
  return {
    add,
    actions(next: IndexActions) {
      for (const source of Object.keys({ ...actions, ...next }) as SearchSourceId[]) {
        const before = actions[source], after = next[source];
        if (before === after) continue;
        if (after?.running && !before?.running) {
          background.delete(source);
          add(source, "info", "Manual indexing started");
        }
        else if (before?.running) {
          if (!after || after.cancelled) add(source, "warning", "Manual indexing stopped; saved batches retained");
          else if (after.error) add(source, "error", "Manual indexing failed; saved batches retained");
          else if (after.result) {
            const { complete, indexed, total } = after.result;
            const counts = Number.isFinite(indexed) && Number.isFinite(total) ? ` (${indexed}/${total})` : "";
            add(source, complete ? "success" : "warning", `${complete ? "Manual indexing complete" : "Manual pass incomplete; Continue available"}${counts}`);
          }
        }
      }
      actions = next;
    },
    snapshot(next: SearchIndexSnapshot) {
      for (const [key, label] of [["error", "Index diagnostics"], ["consentError", "Semantic configuration"], ["activityError", "Search activity"]] as const) {
        if (next[key] && next[key] !== snapshot?.[key]) add("system", "error", `${label} unavailable`);
        else if (!next[key] && snapshot?.[key]) add("system", "info", `${label} restored`);
      }
      if (next.consent && JSON.stringify(next.consent) !== JSON.stringify(snapshot?.consent)) {
        let message = "Semantic configuration available";
        if (!next.consent.configured) message = "Semantic search disabled";
        else if (next.consent.provider === "openrouter" && !next.consent.keyAvailable) message = "Semantic search needs credentials";
        add("system", "info", message);
      }
      for (const source of ["settings", "tasks", "sessions"] as const) {
        const before = snapshot?.activity?.indexingSources?.[source];
        const after = next.activity?.indexingSources?.[source];
        if (after !== before && !actions[source]?.running) {
          if (after === true) {
            background.add(source);
            add(source, "info", "Background index activity observed");
          } else if (background.delete(source)) {
            add(source, "info", after === false ? "Background index activity now idle" : "Index activity status unavailable");
          }
        }
        const error = next.activity?.sourceErrors?.[source];
        const previousError = snapshot?.activity?.sourceErrors?.[source];
        if (error && error !== previousError) add(source, "error", "Source indexing unavailable; inspect its status tooltip");
        else if (!error && previousError && next.activity) add(source, "info", "Source error cleared");
      }
      for (const store of next.stores?.stores ?? []) {
        const before = snapshot?.stores?.stores.find(item => item.id === store.id);
        if (store.state !== before?.state) add("system", store.state === "error" ? "error" : "info", `${store.id} store: ${store.state}`);
        // Polls may miss short jobs. Count changes are evidence of cache updates,
        // never a fabricated start/completion event or a completeness claim.
        const counts = Object.entries(store.counts).sort(([a], [b]) => a.localeCompare(b));
        const prior = Object.entries(before?.counts ?? {}).sort(([a], [b]) => a.localeCompare(b));
        if (JSON.stringify(counts) !== JSON.stringify(prior)) {
          const summary = counts.filter(([, count]) => Number.isFinite(count)).map(([name, count]) => `${name}: ${count}`).join(", ");
          if (summary) add("system", "info", `${store.id} counts: ${summary}`);
        }
      }
      snapshot = next;
    },
  };
}
