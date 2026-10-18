import { fuzzySearch } from "../lib/fuzzy";
import { projectDocumentLabel } from "../lib/project-documents";

/** Sidebar-owned state survives Registry panel unmounts, but never project switches. */
export function createRegistryPlansView() {
  let workspace = $state("");
  let query = $state("");
  let scrollTop = 0;

  function selectWorkspace(next: string): void {
    if (next === workspace) return;
    workspace = next;
    query = "";
    scrollTop = 0;
  }

  function search(next: string): void {
    if (query === next) return;
    query = next;
    scrollTop = 0;
  }

  function visible(plans: readonly string[]): string[] {
    if (!query.trim()) return [...plans];
    return fuzzySearch(plans.map((plan) => ({
      value: plan,
      label: projectDocumentLabel(plan),
      aliases: [plan],
    })), query, { minScorePerCharacter: 4 }).map((match) => match.value);
  }

  function rememberScroll(owner: string, filter: string, top: number): void {
    // A removed panel must not write its old scroll position into a new view.
    if (owner === workspace && filter === query) scrollTop = Math.max(0, top);
  }

  function restoreList(node: HTMLElement, key: { workspace: string; query: string }) {
    node.scrollTop = scrollTop;
    const remember = () => rememberScroll(key.workspace, key.query, node.scrollTop);
    node.addEventListener("scroll", remember);
    return {
      update(next: typeof key) {
        if (next.workspace !== key.workspace || next.query !== key.query) {
          key = next;
          node.scrollTop = scrollTop;
        }
      },
      destroy() {
        remember();
        node.removeEventListener("scroll", remember);
      },
    };
  }

  return {
    get workspace() { return workspace; },
    get query() { return query; },
    get scrollTop() { return scrollTop; },
    selectWorkspace,
    search,
    visible,
    rememberScroll,
    restoreList,
  };
}

export type RegistryPlansView = ReturnType<typeof createRegistryPlansView>;
