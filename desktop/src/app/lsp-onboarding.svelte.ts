import { invoke } from "@tauri-apps/api/core";
import type { AgentControlState } from "../lib/agent-control";
import {
  lspMissingSuggestionFromSessionState,
  lspServerConfigForInstall,
  piToolsSuiteConfigWithLspServer,
  type LspInstallResult,
  type LspMissingSuggestion,
} from "../lib/lsp-onboarding";
import type { SessionStateNotification } from "../lib/session-state";
import { workbenchSessionTabId, type WorkbenchTabId } from "../lib/workbench-tabs";

export type LspInstallerPhase = "installing" | "success" | "error";

export interface LspInstallerState {
  readonly suggestion: LspMissingSuggestion;
  readonly phase: LspInstallerPhase;
  readonly insertAfterId: WorkbenchTabId | null;
  readonly openedOrder: number;
  readonly output?: string;
  readonly error?: string;
}

type SettingsDocument = { content: string };
type ConditionalSettingsWrite = { written: boolean; document: SettingsDocument };

type LspOnboardingOptions = {
  workspace: () => string;
  activeSessionId: () => string | null;
  promptRunning: (sessionId: string) => boolean;
  agentState: (sessionId: string) => AgentControlState;
  pauseActiveAgent: () => Promise<void>;
  setActiveWorkbenchTabId: (id: WorkbenchTabId | null) => void;
  nextWorkbenchAuxOrder: () => number;
};

export function createLspOnboardingStore(options: LspOnboardingOptions) {
  let suggestions = $state<Map<string, LspMissingSuggestion>>(new Map());
  let installer = $state<LspInstallerState | null>(null);
  let pendingInstall = $state<LspMissingSuggestion | null>(null);
  let workspaceGeneration = 0;
  let installGeneration = 0;
  let observedWorkspace = options.workspace();
  const dismissed = new Set<string>();

  function suggestionKey(suggestion: LspMissingSuggestion): string {
    return options.workspace() + "\0" + suggestion.installerId;
  }

  function sessionSuggestionKey(sessionId: string, installerId: string): string {
    return sessionId + "\0" + installerId;
  }

  function suggestionForSession(sessionId: string): LspMissingSuggestion | undefined {
    return [...suggestions.values()].find((suggestion) => suggestion.sessionId === sessionId);
  }

  function handleSessionState(notification: SessionStateNotification): boolean {
    const suggestion = lspMissingSuggestionFromSessionState(notification);
    if (!suggestion) return false;
    if (dismissed.has(suggestionKey(suggestion))) return true;
    const key = sessionSuggestionKey(notification.sessionId, suggestion.installerId);
    if (suggestions.has(key)) return true;
    const next = new Map(suggestions);
    next.set(key, suggestion);
    suggestions = next;
    return true;
  }

  function clearSession(sessionId: string): void {
    const next = new Map(
      [...suggestions].filter(([, suggestion]) => suggestion.sessionId !== sessionId),
    );
    if (next.size !== suggestions.size) suggestions = next;
    if (pendingInstall?.sessionId === sessionId) pendingInstall = null;
  }

  function installBusy(): boolean {
    return pendingInstall !== null || installer?.phase === "installing";
  }

  function dismiss(sessionId: string): void {
    const suggestion = suggestionForSession(sessionId);
    if (!suggestion) return;
    dismissed.add(suggestionKey(suggestion));
    const next = new Map(suggestions);
    next.delete(sessionSuggestionKey(sessionId, suggestion.installerId));
    suggestions = next;
  }

  async function registerServer(result: LspInstallResult): Promise<void> {
    let document = await invoke<SettingsDocument>("read_user_config", { kind: "pi-tools-suite" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const content = piToolsSuiteConfigWithLspServer(
        document.content,
        lspServerConfigForInstall(result),
      );
      const write = await invoke<ConditionalSettingsWrite>("write_user_config_if_unchanged", {
        kind: "pi-tools-suite",
        expectedContent: document.content,
        content,
      });
      if (write.written) return;
      document = write.document;
    }
    throw new Error("pi-tools-suite.jsonc changed repeatedly while registering the LSP. Try again.");
  }

  async function startInstall(suggestion: LspMissingSuggestion): Promise<void> {
    pendingInstall = null;
    const requestWorkspace = options.workspace();
    const generation = workspaceGeneration;
    const requestInstallGeneration = ++installGeneration;
    const existing = installer?.suggestion.installerId === suggestion.installerId ? installer : null;
    installer = {
      suggestion,
      phase: "installing",
      insertAfterId: workbenchSessionTabId(suggestion.sessionId),
      openedOrder: existing?.openedOrder ?? options.nextWorkbenchAuxOrder(),
    };
    options.setActiveWorkbenchTabId("lsp-install");
    try {
      const result = await invoke<LspInstallResult>("install_lsp_server", {
        installerId: suggestion.installerId,
      });
      if (
        requestInstallGeneration !== installGeneration
        || generation !== workspaceGeneration
        || requestWorkspace !== options.workspace()
      ) return;
      await registerServer(result);
      if (
        requestInstallGeneration !== installGeneration
        || generation !== workspaceGeneration
        || requestWorkspace !== options.workspace()
      ) return;
      installer = {
        ...installer!,
        phase: "success",
        output: result.output,
      };
    } catch (error) {
      if (
        requestInstallGeneration !== installGeneration
        || generation !== workspaceGeneration
        || requestWorkspace !== options.workspace()
      ) return;
      installer = {
        ...installer!,
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function pauseAndInstall(sessionId: string): Promise<void> {
    if (installBusy()) return;
    const suggestion = suggestionForSession(sessionId);
    if (!suggestion || sessionId !== options.activeSessionId()) return;
    const next = new Map(suggestions);
    next.delete(sessionSuggestionKey(sessionId, suggestion.installerId));
    suggestions = next;
    pendingInstall = suggestion;
    if (options.agentState(sessionId) === "paused" || !options.promptRunning(sessionId)) {
      await startInstall(suggestion);
      return;
    }
    await options.pauseActiveAgent();
    if (
      pendingInstall === suggestion
      && options.agentState(sessionId) === "paused"
    ) {
      await startInstall(suggestion);
      return;
    }
    if (
      pendingInstall === suggestion
      && options.promptRunning(sessionId)
      && options.agentState(sessionId) === "idle"
    ) {
      pendingInstall = null;
      const next = new Map(suggestions);
      next.set(sessionSuggestionKey(sessionId, suggestion.installerId), suggestion);
      suggestions = next;
    }
  }

  function retry(): void {
    if (installer?.phase !== "error") return;
    void startInstall(installer.suggestion);
  }

  function closeInstaller(): void {
    if (installer?.phase === "installing") return;
    installer = null;
  }

  function reset(): void {
    workspaceGeneration += 1;
    installGeneration += 1;
    suggestions = new Map();
    pendingInstall = null;
    installer = null;
    dismissed.clear();
  }

  $effect(() => {
    const currentWorkspace = options.workspace();
    if (currentWorkspace === observedWorkspace) return;
    observedWorkspace = currentWorkspace;
    reset();
  });

  $effect(() => {
    const pending = pendingInstall;
    if (!pending) return;
    const state = options.agentState(pending.sessionId);
    const running = options.promptRunning(pending.sessionId);
    if (state === "paused" || (!running && state !== "pause-requested" && state !== "resuming")) {
      void startInstall(pending);
    }
  });

  return {
    get suggestions() { return suggestions; },
    get installer() { return installer; },
    activeSuggestion: () => {
      if (installBusy()) return undefined;
      const sessionId = options.activeSessionId();
      return sessionId ? suggestionForSession(sessionId) : undefined;
    },
    handleSessionState,
    dismiss,
    pauseAndInstall,
    retry,
    closeInstaller,
    clearSession,
    reset,
  };
}

export type LspOnboardingStore = ReturnType<typeof createLspOnboardingStore>;
