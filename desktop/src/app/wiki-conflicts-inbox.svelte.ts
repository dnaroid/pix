import { wikiConflictsText } from "../components/wiki-conflicts-text";
import { MAX_KNOWLEDGE_BATCH_FINDINGS } from "../lib/knowledge-resolution";
import type { WikiFindingsSnapshot } from "../components/wiki-consistency-tree-state.svelte";
import {
  filterWikiFindings,
  groupWikiFindings,
  summarizeWikiFindings,
  type WikiFinding,
  type WikiFindingFilter,
} from "../lib/wiki-conflicts-index";
import {
  flattenWikiFindingGroups,
  moveWikiFindingGroup,
  moveWikiFindingRow,
  resolveWikiFindingSelection,
} from "../lib/wiki-conflicts-navigation";

export type WikiConflictsKindFilter = "all" | "conflict" | "uncertainty" | "internal";
export type WikiConflictsStatusFilter = "open" | "fix-pending" | "decided" | "stale" | "all";
export type WikiConflictsGroupBy = "pair" | "page";

/** What an entry point asks the inbox to show. */
export interface WikiConflictsOpenInput {
  /** Project-relative page or folder; becomes the branch filter. */
  readonly path?: string;
  readonly findingId?: string;
}

/**
 * Window-level Wiki Conflicts inbox: filters, grouping and selection shared by
 * the sidebar findings list and the workbench comparison tab.
 */
export function createWikiConflictsInbox(options: { snapshot: () => WikiFindingsSnapshot | null }) {
  let kind = $state<WikiConflictsKindFilter>("all");
  let status = $state<WikiConflictsStatusFilter>("open");
  let groupBy = $state<WikiConflictsGroupBy>("pair");
  let branch = $state("");
  let pendingFindingId = $state<string | null>(null);
  let selectedKey = $state<string | null>(null);
  // Finding ids collected for one batch resolution session; insertion order is kept.
  let basketIds = $state<readonly string[]>([]);

  const snapshot = $derived(options.snapshot());
  const findings = $derived(snapshot?.findings ?? []);
  const language = $derived(findings.find(finding => finding.reportLanguage)?.reportLanguage);
  const text = $derived(wikiConflictsText(language));
  const summary = $derived(summarizeWikiFindings(findings));
  const filter = $derived<WikiFindingFilter>({
    ...(kind === "all" ? {} : { kind }),
    ...(status === "all" ? {} : { status }),
    ...(branch ? { branch } : {}),
  });
  const groups = $derived(groupWikiFindings(filterWikiFindings(findings, filter), groupBy));
  const rows = $derived(flattenWikiFindingGroups(groups));
  const activeKey = $derived(resolveWikiFindingSelection(rows, selectedKey, pendingFindingId));
  const activeIndex = $derived(rows.findIndex(row => row.key === activeKey));
  const activeFinding = $derived<WikiFinding | null>(activeIndex >= 0 ? rows[activeIndex]!.finding : null);
  // Only findings that still exist and are not stale can be handed off.
  const basket = $derived.by(() => {
    const byId = new Map(findings.map(finding => [finding.id, finding]));
    return basketIds.map(id => byId.get(id)).filter((finding): finding is WikiFinding => Boolean(finding && !finding.stale));
  });
  const basketPages = $derived(new Set(basket.flatMap(finding => [finding.draft.path, finding.existing.path])).size);

  function toggleBasket(finding: WikiFinding | null): void {
    if (!finding) return;
    if (basketIds.includes(finding.id)) basketIds = basketIds.filter(id => id !== finding.id);
    else if (!finding.stale && basket.length < MAX_KNOWLEDGE_BATCH_FINDINGS) basketIds = [...basketIds, finding.id];
  }

  /** Drops the given ids (for example, after they were handed off); all when omitted. */
  function clearBasket(ids?: readonly string[]): void {
    if (!ids) { basketIds = []; return; }
    const sent = new Set(ids);
    basketIds = basketIds.filter(id => !sent.has(id));
  }

  function select(key: string | null): void {
    if (!key) return;
    selectedKey = key;
    pendingFindingId = null;
  }

  /** An explicit entry point replaces the branch; a bare open keeps the current view. */
  function apply(input: WikiConflictsOpenInput = {}): void {
    if (!input.path && !input.findingId) return;
    branch = input.path ?? "";
    pendingFindingId = input.findingId ?? null;
    // A specific finding must be visible even when it is stale.
    if (input.findingId) status = "all";
  }

  function reset(): void {
    kind = "all";
    status = "open";
    groupBy = "pair";
    branch = "";
    pendingFindingId = null;
    selectedKey = null;
    basketIds = [];
  }

  return {
    get snapshot() { return snapshot; },
    get findings() { return findings; },
    get text() { return text; },
    get summary() { return summary; },
    get groups() { return groups; },
    get rows() { return rows; },
    get activeKey() { return activeKey; },
    get activeIndex() { return activeIndex; },
    get activeFinding() { return activeFinding; },
    get basket() { return basket; },
    get basketPages() { return basketPages; },
    inBasket(finding: WikiFinding) { return basketIds.includes(finding.id) && !finding.stale; },
    get basketFull() { return basket.length >= MAX_KNOWLEDGE_BATCH_FINDINGS; },
    toggleBasket,
    clearBasket,
    get kind() { return kind; },
    set kind(value: WikiConflictsKindFilter) { kind = value; },
    get status() { return status; },
    set status(value: WikiConflictsStatusFilter) { status = value; },
    get groupBy() { return groupBy; },
    set groupBy(value: WikiConflictsGroupBy) { groupBy = value; },
    get branch() { return branch; },
    clearBranch() { branch = ""; },
    select,
    move(delta: number) { select(moveWikiFindingRow(rows, activeKey, delta)); },
    moveGroup(delta: -1 | 1) { select(moveWikiFindingGroup(rows, activeKey, delta)); },
    first() { select(rows[0]?.key ?? null); },
    last() { select(rows.at(-1)?.key ?? null); },
    apply,
    reset,
  };
}

export type WikiConflictsInbox = ReturnType<typeof createWikiConflictsInbox>;
