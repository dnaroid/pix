import { randomUUID } from "node:crypto";
import { logSearchDiagnostic } from "./search-diagnostics.mjs";

/** Metadata only. A slow diagnostic sink drops heartbeats rather than queuing work. */
export function sessionIndexProgress(root, sessionsTotal, write = logSearchDiagnostic) {
  const runId = randomUUID(), started = performance.now();
  const state = { phase: "waiting_for_lease", sessionsTotal, sessionsChecked: 0, sessionsSkipped: 0,
    chunksDiscovered: 0, cachedChunks: 0, savedVectors: 0, requestsStarted: 0, requestsCompleted: 0 };
  let pending, stopped = false;
  const emit = status => {
    const record = { event: "session_index_progress", runId, status, ...state,
      elapsedMs: Math.round(performance.now() - started) };
    return Promise.resolve().then(() => write(root, record)).catch(() => {});
  };
  const heartbeat = status => {
    if (pending || stopped) return;
    pending = emit(status).finally(() => { pending = undefined; });
  };
  heartbeat("started");
  const timer = setInterval(() => heartbeat("running"), 5000);
  timer.unref?.();
  return {
    state,
    async finish(status) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await pending;
      await emit(status);
    },
  };
}
