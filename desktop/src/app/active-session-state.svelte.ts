import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { emptyTranscript, type TranscriptState } from "../lib/transcript";

export function createActiveSessionState() {
  let sessionId = $state<string | null>(null);
  let transcript = $state<TranscriptState>(emptyTranscript);
  let configOptions = $state<SessionConfigOption[]>([]);
  let runtimeReady = $state(false);
  const transcriptsBySessionId = new Map<string, TranscriptState>();

  function setSessionId(next: string | null): void {
    sessionId = next;
  }

  function setTranscript(next: TranscriptState): void {
    transcript = next;
  }

  function setConfigOptions(next: SessionConfigOption[]): void {
    configOptions = next;
  }

  function setRuntimeReady(next: boolean): void {
    runtimeReady = next;
  }

  function sessionTranscript(targetSessionId: string): TranscriptState | undefined {
    return transcriptsBySessionId.get(targetSessionId);
  }

  function setSessionTranscript(targetSessionId: string, next: TranscriptState): void {
    transcriptsBySessionId.set(targetSessionId, next);
  }

  function deleteSessionTranscript(targetSessionId: string): void {
    transcriptsBySessionId.delete(targetSessionId);
  }

  function clearSessionTranscripts(): void {
    transcriptsBySessionId.clear();
  }

  function transcriptFor(targetSessionId: string): TranscriptState | undefined {
    return targetSessionId === sessionId ? transcript : transcriptsBySessionId.get(targetSessionId);
  }

  function setTranscriptFor(targetSessionId: string, next: TranscriptState): void {
    transcriptsBySessionId.set(targetSessionId, next);
    if (targetSessionId === sessionId) transcript = next;
  }

  function setActiveTranscriptForSession(targetSessionId: string, next: TranscriptState): void {
    transcript = next;
    transcriptsBySessionId.set(targetSessionId, next);
  }

  function saveActiveTranscript(targetSessionId = sessionId): void {
    if (!targetSessionId) return;
    transcriptsBySessionId.set(targetSessionId, transcript);
  }

  function resetConversation(): void {
    runtimeReady = false;
    transcript = emptyTranscript;
    configOptions = [];
  }

  function resetContent(): void {
    transcript = emptyTranscript;
    configOptions = [];
  }

  function resetWorkspaceConversation(): void {
    transcript = emptyTranscript;
    transcriptsBySessionId.clear();
    configOptions = [];
  }

  function clearActiveSession(): void {
    sessionId = null;
    resetConversation();
  }

  function initializeSessionTranscript(targetSessionId: string): void {
    transcript = emptyTranscript;
    transcriptsBySessionId.set(targetSessionId, transcript);
  }

  function initializeActiveConversation(
    targetSessionId: string,
    nextConfigOptions: SessionConfigOption[],
    ready: boolean,
    cacheEmptyTranscript = true,
  ): void {
    transcript = emptyTranscript;
    if (cacheEmptyTranscript) transcriptsBySessionId.set(targetSessionId, transcript);
    configOptions = nextConfigOptions;
    runtimeReady = ready;
  }

  return {
    get sessionId() { return sessionId; },
    get transcript() { return transcript; },
    get configOptions() { return configOptions; },
    get runtimeReady() { return runtimeReady; },
    setSessionId,
    setTranscript,
    setConfigOptions,
    setRuntimeReady,
    sessionTranscript,
    setSessionTranscript,
    deleteSessionTranscript,
    clearSessionTranscripts,
    transcriptFor,
    setTranscriptFor,
    setActiveTranscriptForSession,
    saveActiveTranscript,
    resetConversation,
    resetContent,
    resetWorkspaceConversation,
    clearActiveSession,
    initializeSessionTranscript,
    initializeActiveConversation,
  };
}

export type ActiveSessionState = ReturnType<typeof createActiveSessionState>;
