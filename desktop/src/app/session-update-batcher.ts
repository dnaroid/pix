import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  applySessionUpdates,
  emptyTranscript,
  finalizeTranscriptActivity,
} from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";

type SessionUpdateBatcherOptions = {
  state: ActiveSessionState;
  promptEndedAt: (sessionId: string) => number | undefined;
  promptRunning: (sessionId: string) => boolean;
  clearPromptEndedAt: (sessionId: string) => void;
  followsLatest: () => boolean;
  scheduleScrollToLatest: () => void;
};

export function createSessionUpdateBatcher(options: SessionUpdateBatcherOptions) {
  let pending: Array<{ sessionId: string; update: SessionUpdate; occurredAtMs: number }> = [];
  let frame = 0;

  function enqueue(notification: SessionNotification): void {
    pending.push({
      sessionId: notification.sessionId,
      update: notification.update,
      occurredAtMs: Date.now(),
    });
    if (frame) return;
    frame = requestAnimationFrame(flush);
  }

  function flush(): void {
    frame = 0;
    const queued = pending;
    pending = [];
    if (queued.length === 0) return;

    const activeId = options.state.sessionId;
    const updatesBySession = new Map<string, Array<{ update: SessionUpdate; occurredAtMs: number }>>();
    for (const entry of queued) {
      const updates = updatesBySession.get(entry.sessionId);
      if (updates) updates.push({ update: entry.update, occurredAtMs: entry.occurredAtMs });
      else updatesBySession.set(entry.sessionId, [{ update: entry.update, occurredAtMs: entry.occurredAtMs }]);
    }

    for (const [sessionId, entries] of updatesBySession) {
      const current = sessionId === activeId
        ? options.state.transcript
        : options.state.sessionTranscript(sessionId) ?? emptyTranscript;
      let next = applySessionUpdates(
        current,
        entries.map((entry) => entry.update),
        entries.map((entry) => entry.occurredAtMs),
      );
      const promptEndedAtMs = options.promptEndedAt(sessionId);
      if (promptEndedAtMs !== undefined && !options.promptRunning(sessionId)) {
        next = finalizeTranscriptActivity(next, promptEndedAtMs);
        options.clearPromptEndedAt(sessionId);
      }
      options.state.setSessionTranscript(sessionId, next);
      if (sessionId === activeId) options.state.setTranscript(next);
    }

    if (activeId && options.followsLatest()) options.scheduleScrollToLatest();
  }

  function dispose(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pending = [];
  }

  return { enqueue, dispose };
}
