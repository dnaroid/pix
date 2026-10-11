import { invoke } from "@tauri-apps/api/core";
import type { AcpClient } from "./acp-client";
import { indexNativeRepository } from "./native-repository-search";
import { createSearchIndexController, type SearchIndexViewState } from "./search-index-controller";
import type { SearchIndexStatus, SemanticConsent } from "./search-index-status";
import { SETTINGS_SEARCH_CATALOG } from "./settings-search-catalog";
import type { SearchIndexHistory } from "./search-index-history";

export function createWorkspaceSearchIndexController(
  workspace: string,
  client: Pick<AcpClient, "searchConfig" | "searchIndex"> | null,
  onChange: (state: SearchIndexViewState) => void,
  history?: SearchIndexHistory,
) {
  const controller = createSearchIndexController({
    workspace, history,
    readStores: () => invoke<SearchIndexStatus>("search_index_status", { workspace }),
    readConsent: () => invoke<SemanticConsent>("native_repository_semantic_config"),
    readActivity: client ? signal => client.searchConfig(workspace, { includeSourceStatus: true }, signal) : undefined,
    run: (source, signal) => {
      if (source === "code" || source === "knowledge") return indexNativeRepository(invoke, workspace, source, signal);
      if (!client) return Promise.reject(new Error("Search connection unavailable"));
      return client.searchIndex({ cwd: workspace, source, ...(source === "settings" ? {
        settings: SETTINGS_SEARCH_CATALOG.map(({ id, section, label, description, synonyms }) =>
          ({ id, section, label, description: description ?? "", synonyms: [...synonyms] })),
      } : {}) }, signal);
    },
    onChange,
  });
  window.addEventListener("pix-semantic-config-changed", controller.configChanged);
  return { ...controller, dispose: () => {
    window.removeEventListener("pix-semantic-config-changed", controller.configChanged);
    controller.dispose();
  } };
}
