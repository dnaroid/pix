import type { SessionStateNotification } from "../lib/session-state";
import { BTW_CHANNEL, BTW_MAX_EXCERPT_CHARS, BTW_MAX_EXCERPTS, BTW_MAX_HISTORY, BTW_MAX_HISTORY_CHARS, BTW_MAX_QUESTION, BTW_MAX_RESPONSE,
  isBtwThinkingLevel, parseBtwEvent, parseBtwState, type BtwCommand, type BtwContextInfo, type BtwExcerpt, type BtwMessage, type BtwState, type BtwThinkingLevel } from "../../../acp/src/btw/contract";

export interface BtwTransport {
  command: (sessionId: string, command: BtwCommand) => Promise<BtwState>;
  runtimeReady: (sessionId: string) => boolean;
}

export interface BtwPaneState {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly contextKey: string;
  readonly hidden: boolean;
  readonly draft: string;
  readonly modelRef: string | null;
  readonly thinkingLevel: BtwThinkingLevel | null;
  readonly thinkingByModel: Readonly<Record<string, BtwThinkingLevel>>;
  readonly actualModelRef: string | null;
  readonly actualThinkingLevel: BtwThinkingLevel | null;
  readonly history: readonly BtwMessage[];
  readonly excerpts: readonly BtwExcerpt[];
  readonly busyRequestId: string | null;
  readonly preparing: boolean;
  readonly pendingQuestion: string | null;
  readonly answer: string;
  readonly phase: "idle" | "streaming" | "done" | "cancelled" | "error";
  readonly error: string | null;
  readonly context: BtwContextInfo | undefined;
  readonly historyClipped: boolean;
  readonly historyReset: boolean;
  readonly usage: { inputTokens: number; outputTokens: number } | undefined;
  readonly scrollTop: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Session = Mutable<BtwPaneState> & {
  generation: number; activeRequestId: string | null; sequence: number; eventRevision: number; pendingHistoryText: string | null;
};
let counter = 0;

/** One memory-only conversation per native parent runtime; no persistence ports. */
export function createBtwStore(transport: BtwTransport) {
  const sessions = new Map<string, Session>();
  const openings = new Map<string, symbol>();
  let revision = $state(0);
  const touch = () => { revision += 1; };
  const owns = (state: Session, generation = state.generation) => sessions.get(state.sessionId) === state && state.generation === generation;

  function fresh(sessionId: string, value: BtwState): Session {
    const state: Session = { sessionId, runtimeId: value.runtimeId, contextKey: value.contextKey, busyRequestId: value.busyRequestId,
      hidden: false, draft: "", modelRef: null, actualModelRef: null, history: [], excerpts: [], preparing: false,
      thinkingLevel: null, thinkingByModel: {}, actualThinkingLevel: null,
      pendingQuestion: null, pendingHistoryText: null, answer: "", phase: "idle", error: null, context: undefined,
      historyClipped: false, historyReset: false, usage: undefined, scrollTop: 0, generation: 0, activeRequestId: null, sequence: -1, eventRevision: 0 };
    sessions.set(sessionId, state);
    return state;
  }

  function clearHistory(state: Session): void {
    state.history = []; state.answer = ""; state.context = undefined; state.historyReset = true;
  }

  async function open(sessionId: string): Promise<void> {
    if (!transport.runtimeReady(sessionId)) return;
    const existing = sessions.get(sessionId);
    if (existing) { existing.hidden = false; touch(); }
    const token = Symbol();
    openings.set(sessionId, token);
    const eventRevision = existing?.eventRevision;
    try {
      const value = parseBtwState(await transport.command(sessionId, { action: "state" }));
      if (openings.get(sessionId) !== token || !transport.runtimeReady(sessionId)) return;
      const current = sessions.get(sessionId);
      if (!current || current.runtimeId !== value.runtimeId) fresh(sessionId, value);
      else if (current.eventRevision === eventRevision) {
        current.busyRequestId = value.busyRequestId;
        if (!current.activeRequestId && current.contextKey !== value.contextKey) clearHistory(current);
        current.contextKey = value.contextKey;
      }
      touch();
    } finally { if (openings.get(sessionId) === token) openings.delete(sessionId); }
  }

  function state(sessionId: string | null): BtwPaneState | undefined {
    revision;
    const value = sessionId ? sessions.get(sessionId) : undefined;
    return value ? { ...value } : undefined;
  }

  function hide(sessionId: string): void {
    openings.delete(sessionId);
    const value = sessions.get(sessionId);
    if (value) { value.hidden = true; touch(); }
  }

  function setDraft(sessionId: string, draft: string): void {
    const value = sessions.get(sessionId);
    if (value) { value.draft = draft.slice(0, BTW_MAX_QUESTION); value.error = null; touch(); }
  }

  function setModelThinking(sessionId: string, modelRef: string | null, thinkingLevel: string | null): void {
    const value = sessions.get(sessionId);
    if (!value) return;
    if (thinkingLevel !== null && !isBtwThinkingLevel(thinkingLevel)) throw new Error("Invalid BTW thinking level");
    value.modelRef = modelRef;
    value.thinkingLevel = thinkingLevel;
    if (modelRef && thinkingLevel !== null) {
      // Ephemeral per-model choices; never write the main session's preferences.
      const entries = Object.entries(value.thinkingByModel).filter(([ref]) => ref !== modelRef);
      value.thinkingByModel = Object.fromEntries([...entries.slice(-63), [modelRef, thinkingLevel]]);
    }
    touch();
  }

  function setScroll(sessionId: string, runtimeId: string, top: number): void {
    const value = sessions.get(sessionId);
    if (value?.runtimeId === runtimeId && Number.isFinite(top) && top >= 0 && value.scrollTop !== top) {
      value.scrollTop = top; touch();
    }
  }

  function addExcerpt(sessionId: string, excerpt: BtwExcerpt): boolean {
    const value = sessions.get(sessionId);
    if (!value || !excerpt.text.trim()) return false;
    if (value.excerpts.length >= BTW_MAX_EXCERPTS || excerpt.text.length > BTW_MAX_EXCERPT_CHARS) {
      value.error = "Attach at most 4 text excerpts, each up to 8,000 characters."; touch(); return false;
    }
    value.excerpts = [...value.excerpts, { label: excerpt.label.slice(0, 160), text: excerpt.text }]; touch(); return true;
  }

  function removeExcerpt(sessionId: string, index: number): void {
    const value = sessions.get(sessionId);
    if (value) { value.excerpts = value.excerpts.filter((_, i) => i !== index); touch(); }
  }

  function trimHistory(value: Session): void {
    const history = [...value.history];
    let chars = history.reduce((sum, message) => sum + message.text.length, 0);
    while (history.length > BTW_MAX_HISTORY || chars > BTW_MAX_HISTORY_CHARS) {
      chars -= history.splice(0, 2).reduce((sum, message) => sum + message.text.length, 0);
      value.historyClipped = true;
    }
    value.history = history;
  }

  async function cancelRequest(value: Session, requestId: string): Promise<void> {
    const generation = value.generation;
    const revision = value.eventRevision;
    try {
      const response = await transport.command(value.sessionId, { action: "cancel", requestId, runtimeId: value.runtimeId });
      if (owns(value, generation) && value.eventRevision === revision && response.runtimeId === value.runtimeId) {
        value.busyRequestId = response.busyRequestId; touch();
      }
    } catch { /* Next state refresh rechecks the physical lock; never retry inference. */ }
  }

  async function send(sessionId: string, questionOverride?: string): Promise<void> {
    const value = sessions.get(sessionId);
    if (!value || !transport.runtimeReady(sessionId) || value.activeRequestId || value.preparing) return;
    const question = (questionOverride ?? value.draft).trim();
    if (!question) return;
    if (question.length > BTW_MAX_QUESTION) { value.error = "BTW questions are limited to 8,000 characters."; touch(); return; }
    const generation = value.generation;
    const selection = { modelRef: value.modelRef, thinkingLevel: value.thinkingLevel };
    value.preparing = true; value.error = null; touch();
    let requestId: string | undefined;
    try {
      const current = parseBtwState(await transport.command(sessionId, { action: "state" }));
      if (!owns(value, generation) || !transport.runtimeReady(sessionId)) return;
      if (current.runtimeId !== value.runtimeId) {
        const replacement = fresh(sessionId, current);
        replacement.error = "Parent runtime was replaced. The temporary conversation was cleared."; touch(); return;
      }
      value.busyRequestId = current.busyRequestId;
      if (value.busyRequestId) { value.error = "The previous BTW request is still finishing."; return; }
      if (current.contextKey !== value.contextKey) clearHistory(value);
      value.contextKey = current.contextKey;
      trimHistory(value);
      const excerpts = value.excerpts;
      const draft = value.draft;
      requestId = `btw-${Date.now().toString(36)}-${++counter}`;
      const command: BtwCommand = { action: "ask", requestId, runtimeId: value.runtimeId, question,
        history: value.history.map((message) => ({ ...message })), excerpts: excerpts.map((excerpt) => ({ ...excerpt })),
        contextKey: value.contextKey, ...(selection.modelRef ? { modelRef: selection.modelRef } : {}),
        ...(selection.thinkingLevel !== null ? { thinkingLevel: selection.thinkingLevel } : {}) };
      value.activeRequestId = requestId; value.busyRequestId = requestId; value.sequence = -1;
      value.phase = "streaming"; value.answer = ""; value.pendingQuestion = question;
      const historyText = [question, ...excerpts.map((excerpt) => `\n[Explicit excerpt: ${excerpt.label}]\n${excerpt.text}`)].join("\n");
      const userBudget = BTW_MAX_HISTORY_CHARS - BTW_MAX_RESPONSE;
      const clipped = "\n[Attached excerpt text shortened in side history]";
      value.pendingHistoryText = historyText.length > userBudget ? historyText.slice(0, userBudget - clipped.length) + clipped : historyText;
      value.historyClipped ||= historyText.length > userBudget;
      const sentRevision = value.eventRevision;
      touch();
      const accepted = parseBtwState(await transport.command(sessionId, command));
      if (!owns(value, generation)) return;
      if (accepted.runtimeId !== value.runtimeId) return;
      // A very fast terminal event can arrive before this acknowledgement.
      if (value.activeRequestId === requestId && value.eventRevision === sentRevision) value.busyRequestId = accepted.busyRequestId;
      if (value.draft === draft) value.draft = "";
      if (value.excerpts === excerpts) value.excerpts = [];
    } catch {
      if (!owns(value, generation)) return;
      if (requestId && value.activeRequestId !== requestId) return;
      value.activeRequestId = null; value.pendingQuestion = null; value.pendingHistoryText = null;
      value.phase = "error"; value.error = "Could not start BTW. Check the model and credentials, then retry.";
      if (requestId) void cancelRequest(value, requestId);
      else value.busyRequestId = null;
    } finally {
      if (owns(value, generation)) { value.preparing = false; touch(); }
    }
  }

  async function stop(sessionId: string): Promise<void> {
    const value = sessions.get(sessionId);
    if (!value) return;
    value.generation += 1; value.preparing = false;
    const requestId = value.activeRequestId ?? value.busyRequestId;
    value.activeRequestId = null; value.pendingQuestion = null; value.pendingHistoryText = null;
    value.answer = ""; value.phase = "cancelled"; touch();
    if (requestId) await cancelRequest(value, requestId);
  }

  function newConversation(sessionId: string): void {
    const value = sessions.get(sessionId);
    if (!value) return;
    void stop(sessionId);
    value.history = []; value.draft = ""; value.excerpts = []; value.answer = "";
    value.context = undefined; value.historyClipped = false; value.historyReset = false;
    value.phase = "idle"; value.error = null; value.usage = undefined; value.scrollTop = 0; touch();
  }

  function clearSession(sessionId: string): void {
    openings.delete(sessionId);
    const value = sessions.get(sessionId);
    if (value) { void stop(sessionId); sessions.delete(sessionId); touch(); }
  }

  function reset(): void {
    openings.clear();
    for (const id of [...sessions.keys()]) clearSession(id);
  }

  function handleSessionState(notification: SessionStateNotification): boolean {
    if (notification.channel !== BTW_CHANNEL) return false;
    const event = parseBtwEvent(notification.data);
    const value = sessions.get(notification.sessionId);
    // Consume malformed/late BTW packets here, never pass them to activity/transcript.
    if (!event || !value || value.runtimeId !== event.runtimeId) return true;
    if (event.phase === "reset") { clearSession(notification.sessionId); return true; }
    if (value.activeRequestId !== event.requestId) {
      // An ignored-abort request can finish after Stop/New conversation. Only release its lock.
      if (value.busyRequestId === event.requestId && event.busyRequestId === null) { value.busyRequestId = null; value.eventRevision++; touch(); }
      return true;
    }
    if (event.sequence <= value.sequence) return true;
    value.sequence = event.sequence; value.eventRevision++;
    if (event.context) {
      if (event.context.historyReset) clearHistory(value);
      value.context = event.context; value.contextKey = event.context.key;
    }
    value.actualModelRef = event.modelRef ?? value.actualModelRef;
    value.actualThinkingLevel = event.thinkingLevel ?? value.actualThinkingLevel;
    value.busyRequestId = event.busyRequestId === undefined ? (event.phase === "streaming" ? event.requestId : null) : event.busyRequestId;
    value.phase = event.phase;
    value.answer = event.text;
    if (event.usage) value.usage = event.usage;
    if (event.phase === "done") {
      if (value.pendingHistoryText) value.history = [...value.history, { role: "user", text: value.pendingHistoryText }, { role: "assistant", text: event.text }];
      trimHistory(value); value.answer = "";
    }
    if (event.phase !== "streaming") {
      value.activeRequestId = null; value.pendingQuestion = null; value.pendingHistoryText = null;
      value.error = event.error ?? null;
    }
    touch(); return true;
  }

  return { open, hide, state, setDraft, setModelThinking, setScroll, addExcerpt, removeExcerpt, send, stop, newConversation, clearSession, reset, handleSessionState };
}

export type BtwStore = ReturnType<typeof createBtwStore>;
