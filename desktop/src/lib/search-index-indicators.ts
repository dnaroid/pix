import type { SearchIndexViewState } from "./search-index-controller";
import { buildSearchSourceRows } from "./search-index-status";
import { SETTINGS_SEARCH_CATALOG } from "./settings-search-catalog";
import type { SidebarIndicatorReason } from "./sidebar-indicator-types";

/** Stored vector counts are not evidence of full coverage or freshness. */
export function searchIndexIndicatorReasons(view?: SearchIndexViewState): SidebarIndicatorReason[] {
  if (!view) return [];
  const { snapshot, actions } = view;
  const rows = buildSearchSourceRows(snapshot.stores, snapshot.consent, snapshot.activity, SETTINGS_SEARCH_CATALOG.length);
  const errors = [snapshot.error, snapshot.consentError, snapshot.activityError].filter((error): error is string => Boolean(error));
  const active: string[] = [];
  const pending: string[] = [];
  for (const row of rows) {
    const action = actions[row.id];
    if (action?.running || row.semanticActive) active.push(row.label);
    if (action?.error && !action.cancelled) errors.push(`${row.label}: ${action.error}`);
    else if (row.local === "error" || row.semantic === "error") errors.push(`${row.label}: ${row.local === "error" ? row.localDetail : row.semanticDetail}`);
    if (row.local === "missing" || row.local === "incomplete" || row.semantic === "incompatible"
      || row.semantic === "unavailable" || (snapshot.stores && row.semantic === "no-vectors" && row.localSummary !== "0 items" && row.localSummary !== "0 chunks")
      || action?.result?.complete === false || action?.cancelled) pending.push(row.label);
  }
  const reasons: SidebarIndicatorReason[] = [];
  if (errors.length) reasons.push({ id: "search.error", tone: "error", reason: errors.join("; ") });
  if (active.length) reasons.push({ id: "search.indexing", tone: "info", animated: true, reason: `Indexing: ${active.join(", ")}` });
  // Retain pending causes for the menu while active work owns the blue dot.
  if (pending.length) reasons.push({ id: "search.pending", tone: active.length ? "info" : "warning", reason: `Search indexes need attention: ${pending.join(", ")}` });
  return reasons;
}
