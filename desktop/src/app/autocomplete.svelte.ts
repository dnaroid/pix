import type { AcpClient } from "../lib/acp-client";

type AutocompleteStoreOptions = {
  client: () => AcpClient | null;
  activeSessionId: () => string | null;
  settingsReady: () => boolean;
  promptReady: () => boolean;
  workspace?: () => string;
  reportError?: (error: unknown) => void;
};

export function createAutocompleteStore(options: AutocompleteStoreOptions) {
  let enabled = $state(false);
  let debounceMs = $state(350);
  let generation = 0;

  $effect(() => {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    const currentGeneration = ++generation;
    enabled = false;
    debounceMs = 350;
    if (!requestClient || !sessionId || !options.settingsReady()) return;
    void requestClient.autocompleteSettings(sessionId)
      .then((settings) => {
        if (
          currentGeneration !== generation
          || requestClient !== options.client()
          || sessionId !== options.activeSessionId()
        ) return;
        enabled = settings.enabled;
        debounceMs = settings.debounceMs;
      })
      .catch(() => {});
  });

  async function refresh(sessionId: string): Promise<void> {
    const requestClient = options.client();
    if (!requestClient || sessionId !== options.activeSessionId()) return;
    const settings = await requestClient.autocompleteSettings(sessionId).catch(() => undefined);
    if (!settings || requestClient !== options.client() || sessionId !== options.activeSessionId()) return;
    enabled = settings.enabled;
    debounceMs = settings.debounceMs;
  }

  function complete(draft: string, signal: AbortSignal): Promise<string> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (!requestClient || !sessionId || !options.promptReady()) return Promise.resolve("");
    return requestClient.autocomplete(sessionId, draft, signal);
  }

  return {
    get enabled() { return enabled; },
    get debounceMs() { return debounceMs; },
    refresh,
    complete,
    get fileMentionContextKey() { return options.workspace?.() ?? ""; },
    fileMentions(query: string, signal: AbortSignal) {
      const client = options.client();
      const workspace = options.workspace?.();
      if (!client || !workspace) return Promise.resolve([]);
      return client.fileMentions(workspace, query, signal).catch((error: unknown) => {
        if (!signal.aborted) options.reportError?.(error);
        throw error;
      });
    },
  };
}
