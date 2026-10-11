import type { AcpClient } from "./acp-client";
import type { SettingsSearchEntry } from "./settings-search-catalog";
export type SearchSyncEvent = "started" | "completed" | "failed" | "cancelled";

/** Workspace lifetime, not the visibility or contents of the Settings editor. */
export function startSearchIndexSync(
  client: Pick<AcpClient, "searchSync">,
  cwd: string,
  catalog: readonly SettingsSearchEntry[],
  events: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  onEvent?: (event: SearchSyncEvent) => void,
): () => void {
  const settings = catalog.map(({ id, section, label, description, synonyms }) => ({
    id, section, label, description: description ?? "", synonyms: [...synonyms],
  }));
  let disposed = false;
  let request: AbortController | undefined;
  let pending = false;
  const cancel = () => {
    request?.abort();
    if (pending) onEvent?.("cancelled");
    pending = false;
  };
  const sync = () => {
    if (disposed) return;
    cancel();
    request = new AbortController();
    const current = request;
    pending = true;
    onEvent?.("started");
    // Provider/connection failures are exposed by search status; no automatic retry loop.
    void client.searchSync({ cwd, settings }, current.signal).then(() => {
      if (!disposed && request === current && !current.signal.aborted) { pending = false; onEvent?.("completed"); }
    }).catch(() => {
      if (!disposed && request === current && !current.signal.aborted) { pending = false; onEvent?.("failed"); }
    });
  };
  events.addEventListener("pix-semantic-config-changed", sync);
  sync();
  return () => {
    disposed = true;
    cancel();
    events.removeEventListener("pix-semantic-config-changed", sync);
  };
}
