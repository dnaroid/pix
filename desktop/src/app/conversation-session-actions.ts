import { open } from "@tauri-apps/plugin-dialog";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import {
  appendLocalSystemMessage,
  appendLocalUserMessage,
  emptyTranscript,
} from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";

type ConversationSessionActionsOptions = {
  client: () => AcpClient | null;
  state: ActiveSessionState;
  workspace: () => string;
  operationRunning: () => boolean;
  setOperationRunning: (running: boolean) => void;
  promptRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  setErrorMessage: (message: string | null) => void;
  setPromptText: (text: string) => void;
  markRuntimeReady: (sessionId: string, options: SessionConfigOption[]) => void;
  forgetRuntime: (sessionId: string) => void;
  beginHistoryLoad: () => number;
  hydrateHistory: (
    client: AcpClient,
    sessionId: string,
    workspace: string,
    generation: number,
  ) => Promise<void>;
  refreshSessions: () => void | Promise<void>;
  closeProjectSelector: () => void;
  closeSessionSelector: () => void;
  clearCommandPicker: () => void;
  requestLocalTextInput: (message: string, title: string) => Promise<string | undefined>;
  nextLocalMessageId: () => string;
  scrollToLatest: () => Promise<void>;
  reportError: (error: unknown) => void;
};

export function createConversationSessionActions(options: ConversationSessionActionsOptions) {
  async function enhancePromptDraft(initialDraft: string): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.state.sessionId;
    if (!requestClient || !sessionId || !options.state.runtimeReady) return;

    let draft = initialDraft.trim();
    if (!draft) {
      draft = await options.requestLocalTextInput(
        "Enter the prompt draft to improve. The enhanced text will be returned to the composer without sending it.",
        "Prompt draft",
      ) ?? "";
    }
    if (!draft) return;

    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      const enhanced = await requestClient.enhancePrompt(sessionId, draft);
      if (requestClient !== options.client() || sessionId !== options.state.sessionId) return;
      options.setPromptText(enhanced);
    } catch (error) {
      options.reportError(error);
    } finally {
      if (requestClient === options.client() && sessionId === options.state.sessionId) {
        options.setOperationRunning(false);
      }
    }
  }

  async function chooseImportSession(): Promise<void> {
    const workspace = options.workspace();
    const selected = await open({
      directory: false,
      multiple: false,
      title: "Import Pix session",
      filters: [{ name: "Pix session", extensions: ["jsonl"] }],
      ...(workspace ? { defaultPath: workspace } : {}),
    });
    if (typeof selected === "string") await importConversationPath(selected);
  }

  async function importConversationPath(path: string): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.state.sessionId;
    const requestWorkspace = options.workspace();
    if (
      !requestClient
      || !sessionId
      || !options.state.runtimeReady
      || options.operationRunning()
      || options.promptRunning()
    ) return;
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      const response = await requestClient.importSession(sessionId, path);
      if (
        requestClient !== options.client()
        || sessionId !== options.state.sessionId
        || requestWorkspace !== options.workspace()
      ) return;
      options.state.setTranscript(emptyTranscript);
      options.state.deleteSessionTranscript(sessionId);
      options.state.setConfigOptions(response.configOptions);
      options.markRuntimeReady(sessionId, response.configOptions);
      const generation = options.beginHistoryLoad();
      await options.hydrateHistory(requestClient, sessionId, requestWorkspace, generation);
      if (requestClient !== options.client() || sessionId !== options.state.sessionId) return;
      const next = appendLocalSystemMessage(
        options.state.transcript,
        `Imported session from ${path}`,
        options.nextLocalMessageId(),
      );
      options.state.setTranscript(next);
      options.state.setSessionTranscript(sessionId, next);
      void options.refreshSessions();
    } catch (error) {
      options.reportError(error);
    } finally {
      if (requestClient === options.client() && sessionId === options.state.sessionId) {
        options.setOperationRunning(false);
      }
    }
  }

  async function reloadResources(config: { echo?: boolean } = {}): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.state.sessionId;
    if (
      !requestClient
      || !sessionId
      || !options.state.runtimeReady
      || options.operationRunning()
      || options.promptRunning()
      || options.sessionHistoryLoading()
    ) return;
    options.closeProjectSelector();
    options.closeSessionSelector();
    options.clearCommandPicker();
    options.setOperationRunning(true);
    options.state.setRuntimeReady(false);
    options.setErrorMessage(null);
    if (config.echo !== false) {
      const next = appendLocalUserMessage(
        options.state.transcript,
        "/reload",
        options.nextLocalMessageId(),
        [],
        { localOnly: true },
      );
      options.state.setTranscript(next);
      options.state.setSessionTranscript(sessionId, next);
      await options.scrollToLatest();
    }
    try {
      const response = await requestClient.reloadSession(sessionId);
      if (requestClient !== options.client() || sessionId !== options.state.sessionId) return;
      options.state.setConfigOptions(response.configOptions);
      options.markRuntimeReady(sessionId, response.configOptions);
      void options.refreshSessions();
    } catch (error) {
      if (requestClient === options.client() && sessionId === options.state.sessionId) {
        options.forgetRuntime(sessionId);
        options.reportError(error);
      }
    } finally {
      if (requestClient === options.client() && sessionId === options.state.sessionId) {
        options.setOperationRunning(false);
      }
    }
  }

  async function resumeConversationPath(path: string): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.state.sessionId;
    const requestWorkspace = options.workspace();
    if (
      !requestClient
      || !sessionId
      || !options.state.runtimeReady
      || options.operationRunning()
      || options.promptRunning()
    ) return;
    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      const response = await requestClient.resumeSessionPath(sessionId, path);
      if (
        requestClient !== options.client()
        || sessionId !== options.state.sessionId
        || requestWorkspace !== options.workspace()
      ) return;
      options.state.setTranscript(emptyTranscript);
      options.state.deleteSessionTranscript(sessionId);
      options.state.setConfigOptions(response.configOptions);
      options.markRuntimeReady(sessionId, response.configOptions);
      const generation = options.beginHistoryLoad();
      await options.hydrateHistory(requestClient, sessionId, requestWorkspace, generation);
      if (requestClient !== options.client() || sessionId !== options.state.sessionId) return;
      const next = appendLocalSystemMessage(
        options.state.transcript,
        `Resumed session ${path}`,
        options.nextLocalMessageId(),
      );
      options.state.setTranscript(next);
      options.state.setSessionTranscript(sessionId, next);
      void options.refreshSessions();
    } catch (error) {
      options.reportError(error);
    } finally {
      if (requestClient === options.client() && sessionId === options.state.sessionId) {
        options.setOperationRunning(false);
      }
    }
  }

  return {
    enhancePromptDraft,
    chooseImportSession,
    importConversationPath,
    reloadResources,
    resumeConversationPath,
  };
}
