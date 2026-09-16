import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  applySessionUpdates,
  emptyTranscript,
  finalizeTranscriptActivity,
} from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";

type SessionUpdateBatcherOptions = {
  state: Pick<ActiveSessionState, "sessionId" | "transcript" | "sessionTranscript" | "setSessionTranscript" | "setTranscript">;
  promptEndedAt: (sessionId: string) => number | undefined;
  promptRunning: (sessionId: string) => boolean;
  clearPromptEndedAt: (sessionId: string) => void;
  followsLatest: () => boolean;
  scheduleScrollToLatest: () => void;
};

// A suspended/background window can accumulate much more than one IPC batch.
// Keep replay work bounded so input and painting can run between chunks.
const MAX_UPDATES_PER_FRAME = 128;

export function createSessionUpdateBatcher(options: SessionUpdateBatcherOptions) {
  let pending: Array<{ sessionId: string; update: SessionUpdate; occurredAtMs: number }> = [];
  const pendingCounts = new Map<string, number>();
  let pendingOffset = 0;
  let frame: number | null = null;
  let generation = 0;
  let disposed = false;

  function enqueue(notification: SessionNotification): void {
    if (disposed) return;
    pending.push({
      sessionId: notification.sessionId,
      update: notification.update,
      occurredAtMs: Date.now(),
    });
    pendingCounts.set(notification.sessionId, (pendingCounts.get(notification.sessionId) ?? 0) + 1);
    schedule();
  }

  function schedule(): void {
    if (frame !== null || pendingOffset === pending.length || disposed) return;
    const scheduledGeneration = generation;
    frame = requestAnimationFrame(() => {
      if (scheduledGeneration !== generation || disposed) return;
      flush();
    });
  }

  function flush(): void {
    frame = null;
    const end = Math.min(pendingOffset + MAX_UPDATES_PER_FRAME, pending.length);
    const queued = pending.slice(pendingOffset, end);
    pendingOffset = end;
    if (pendingOffset === pending.length) {
      pending = [];
      pendingOffset = 0;
    } else if (pendingOffset >= 1024 && pendingOffset >= pending.length / 2) {
      // Compact occasionally, not once per frame (which would copy the backlog quadratically).
      pending = pending.slice(pendingOffset);
      pendingOffset = 0;
    }
    if (queued.length === 0) return;

    const activeId = options.state.sessionId;
    const updatesBySession = new Map<string, Array<{ update: SessionUpdate; occurredAtMs: number }>>();
    for (const entry of queued) {
      const remaining = (pendingCounts.get(entry.sessionId) ?? 1) - 1;
      if (remaining > 0) pendingCounts.set(entry.sessionId, remaining);
      else pendingCounts.delete(entry.sessionId);
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
        // Keep the completion boundary until every queued chunk has been finalized.
        if (!pendingCounts.has(sessionId)) options.clearPromptEndedAt(sessionId);
      }
      options.state.setSessionTranscript(sessionId, next);
      if (sessionId === activeId) options.state.setTranscript(next);
    }

    if (activeId && updatesBySession.has(activeId) && options.followsLatest()) options.scheduleScrollToLatest();
    schedule();
  }

  function reset(): void {
    generation += 1;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pending = [];
    pendingOffset = 0;
    pendingCounts.clear();
  }

  function discardSession(sessionId: string): void {
    pending = pending.slice(pendingOffset).filter((entry) => entry.sessionId !== sessionId);
    pendingOffset = 0;
    pendingCounts.delete(sessionId);
    if (pending.length === 0) reset();
  }

  function dispose(): void {
    disposed = true;
    reset();
  }

  return { enqueue, reset, discardSession, dispose };
}
