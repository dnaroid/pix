import { untrack } from "svelte";
import type { AcpClient } from "./acp-client";
import { emptySearchIndexView, type SearchIndexController } from "./search-index-controller";
import { createWorkspaceSearchIndexController } from "./workspace-search-index-controller";
import { startSearchIndexSync } from "./search-index-sync";
import { SETTINGS_SEARCH_CATALOG } from "./settings-search-catalog";
import { createSearchIndexHistory } from "./search-index-history";

const history = createSearchIndexHistory();

export function createWorkspaceSearchIndexOwner(options: {
  workspace(): string;
  client(): AcpClient | null | undefined;
}) {
  // Sidebar props arrive as one spread object. Compare identities before owning
  // effects so unrelated task/git/navigation updates cannot restart search work.
  const workspace = $derived(options.workspace());
  const client = $derived(options.client() ?? null);
  let view = $state(emptySearchIndexView());
  let controller = $state<SearchIndexController | null>(null);
  $effect(() => {
    const selected = workspace;
    const connection = client;
    return untrack(() => {
      view = emptySearchIndexView();
      controller = null;
      if (!selected) return;
      const owner = createWorkspaceSearchIndexController(selected, connection, state => { view = state; }, history);
      controller = owner;
      const stopSync = connection ? startSearchIndexSync(connection, selected, SETTINGS_SEARCH_CATALOG, window, owner.syncEvent) : undefined;
      return () => { stopSync?.(); owner.dispose(); };
    });
  });
  return { get view() { return view; }, get controller() { return controller; } };
}
