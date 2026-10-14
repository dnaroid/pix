import { invoke } from "@tauri-apps/api/core";
import type { AcpClient } from "./acp-client";
import { indexNativeRepository, requestNative } from "./native-repository-search";
import { createSearchIndexFreshness } from "./search-index-freshness";
import { createSearchIndexController, type SearchIndexViewState } from "./search-index-controller";
import type { SearchIndexStatus, SemanticConsent } from "./search-index-status";
import { SETTINGS_SEARCH_CATALOG } from "./settings-search-catalog";
import { readSearchSourceSelection, setSearchSourceSelection, SEARCH_SOURCE_SELECTION_CHANGED } from "./search-source-selection";
import { runManagedIndex, type ManualRequest, type ManualReply } from "../../../external/pi-tools-suite/src/project-search/managed-index-run.mjs";

export function createWorkspaceSearchIndexController(
  workspace: string,
  client: Pick<AcpClient, "searchConfig" | "searchIndex"> | null,
  onChange: (state: SearchIndexViewState) => void,
) {
  const settings = SETTINGS_SEARCH_CATALOG.map(({ id, section, label, description, synonyms }) =>
    ({ id, section, label, description: description ?? "", synonyms: [...synonyms] }));
  const digest = crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(settings)))
    .then(buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join(""));
  const control = (request: ManualRequest) => requestNative<ManualReply>(invoke, workspace, {
    operation: "index-control", ...request,
  }, AbortSignal.timeout(15_000));
  const freshness = createSearchIndexFreshness({ workspace, shared: true,
    probe: async (sources, signal) => {
      let sessionSnapshot: string | undefined;
      if (sources.includes("sessions") && client) {
        try { sessionSnapshot = (await client.searchConfig(workspace, { includeSessionSnapshot: true }, signal)).sessionSnapshot; }
        catch { signal.throwIfAborted(); } // Native metadata reconciliation remains available while ACP reconnects.
      }
      return requestNative(invoke, workspace, {
        operation: "snapshot-probe", sources, settingsDigest: await digest,
        ...(sessionSnapshot ? { sessionSnapshot } : {}),
      }, signal);
    },
  });
  const controller = createSearchIndexController({
    workspace,
    readStores: () => invoke<SearchIndexStatus>("search_index_status", { workspace }),
    readConsent: () => invoke<SemanticConsent>("native_repository_semantic_config"),
    readActivity: client ? signal => client.searchConfig(workspace, { includeSourceStatus: true }, signal) : undefined,
    readSelection: signal => readSearchSourceSelection(workspace, signal),
    readFreshness: (signal, force) => freshness.read(signal, force),
    setSource: (source, enabled, signal) => setSearchSourceSelection(workspace, source, enabled, signal),
    run: async (source, signal) => runManagedIndex(control, source, signal, owned => {
      if (source === "code" || source === "knowledge") return indexNativeRepository(invoke, workspace, source, owned);
      if (!client) return Promise.reject(new Error("Search connection unavailable"));
      return client.searchIndex({ cwd: workspace, source, ...(source === "settings" ? {
        settings,
      } : {}) }, owned);
    }, await digest),
    onChange,
  });
  const configChanged = () => { freshness.invalidate(); controller.configChanged(); };
  window.addEventListener("pix-semantic-config-changed", configChanged);
  const selectionChanged = (event: Event) => {
    const detail = (event as CustomEvent<{ workspace?: string; global?: boolean }>).detail;
    if (detail?.global || detail?.workspace === workspace) configChanged();
  };
  window.addEventListener(SEARCH_SOURCE_SELECTION_CHANGED, selectionChanged);
  return { ...controller, configChanged, dispose: () => {
    window.removeEventListener("pix-semantic-config-changed", configChanged);
    window.removeEventListener(SEARCH_SOURCE_SELECTION_CHANGED, selectionChanged);
    controller.dispose();
  } };
}
