/** Sidebar-owned list position survives plan panel unmounts, but never project switches. */
export function createRegistryPlansView() {
  let workspace = $state("");
  let scrollTop = 0;

  function selectWorkspace(next: string): void {
    if (next === workspace) return;
    workspace = next;
    scrollTop = 0;
  }

  function rememberScroll(owner: string, top: number): void {
    // A removed panel must not write its old scroll position into a new view.
    if (owner === workspace) scrollTop = Math.max(0, top);
  }

  function restoreList(node: HTMLElement, key: { workspace: string }) {
    node.scrollTop = scrollTop;
    const remember = () => rememberScroll(key.workspace, node.scrollTop);
    node.addEventListener("scroll", remember);
    return {
      update(next: typeof key) {
        if (next.workspace !== key.workspace) {
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
    get scrollTop() { return scrollTop; },
    selectWorkspace,
    rememberScroll,
    restoreList,
  };
}

export type RegistryPlansView = ReturnType<typeof createRegistryPlansView>;
