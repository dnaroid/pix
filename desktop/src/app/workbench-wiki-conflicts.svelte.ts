import type { WikiFindingsSnapshot } from "../components/wiki-consistency-tree-state.svelte";
import type { WorkbenchTabId } from "../lib/workbench-tabs";
import { createWikiConflictsInbox, type WikiConflictsInbox, type WikiConflictsOpenInput } from "./wiki-conflicts-inbox.svelte";

export type { WikiConflictsOpenInput } from "./wiki-conflicts-inbox.svelte";

type WorkbenchWikiConflictsStateOptions = {
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  setActiveWorkbenchTabId: (id: WorkbenchTabId | null) => void;
  nextWorkbenchAuxOrder: () => number;
  /** Read lazily; null when the project has no configured Wiki. */
  snapshot?: () => WikiFindingsSnapshot | null;
  /** Reveals the Wiki sidebar panel so its Conflicts list is visible. */
  revealList?: () => void | Promise<void>;
};

/** Which list the Wiki sidebar panel shows. */
export type WikiSidebarView = "pages" | "conflicts";

/** Entry points below App open Wiki Conflicts through context instead of prop drilling. */
export interface WikiConflictsNavigation {
  /** Entry points: applies the request, shows the Conflicts list and the comparison tab. */
  open(input?: WikiConflictsOpenInput): void;
  /** Shows the comparison tab only; the list is already visible. */
  reveal(): void;
  /** Current (non-stale) conflicts and uncertainties for badges. */
  readonly openCount: number;
  readonly inbox: WikiConflictsInbox;
  sidebarView: WikiSidebarView;
}

export const WIKI_CONFLICTS_NAVIGATION_CONTEXT = Symbol("wiki-conflicts-navigation");

/**
 * One Wiki Conflicts tab per window; reopening focuses it and keeps its placement.
 * The findings list lives in the Wiki sidebar panel, the tab shows only the comparison.
 */
export function createWorkbenchWikiConflictsState(options: WorkbenchWikiConflictsStateOptions) {
  let open = $state(false);
  let insertAfterId = $state<WorkbenchTabId | null>(null);
  let openedOrder = $state(0);
  let sidebarView = $state<WikiSidebarView>("pages");
  const inbox = createWikiConflictsInbox({ snapshot: () => options.snapshot?.() ?? null });

  function reveal(): void {
    if (!open) {
      const active = options.activeWorkbenchTabId();
      insertAfterId = active === "wiki-conflicts" ? null : active;
      openedOrder = options.nextWorkbenchAuxOrder();
      open = true;
    }
    options.setActiveWorkbenchTabId("wiki-conflicts");
  }

  function showList(): void {
    sidebarView = "conflicts";
    void options.revealList?.();
  }

  function show(input: WikiConflictsOpenInput = {}): void {
    inbox.apply(input);
    reveal();
    showList();
  }

  /** Closing the tab keeps the inbox filters; only a workspace reset clears them. */
  function close(): void {
    open = false;
    insertAfterId = null;
    openedOrder = 0;
  }

  function reset(): void {
    close();
    sidebarView = "pages";
    inbox.reset();
  }

  return {
    get open() { return open; },
    get insertAfterId() { return insertAfterId; },
    get openedOrder() { return openedOrder; },
    get sidebarView() { return sidebarView; },
    set sidebarView(value: WikiSidebarView) { sidebarView = value; },
    inbox,
    show,
    reveal,
    showList,
    close,
    reset,
  };
}

export type WorkbenchWikiConflictsState = ReturnType<typeof createWorkbenchWikiConflictsState>;
