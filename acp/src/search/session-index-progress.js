import { randomUUID } from "node:crypto";
import { classifyIndexFailure, logSearchDiagnostic } from "./search-logging.js";

/** In-memory counters; only terminal metadata enters the shared Pix logger. */
export function sessionIndexProgress(root, sessionsTotal, write = logSearchDiagnostic) {
  const runId = randomUUID(), started = performance.now();
  const state = { phase: "waiting_for_lease", sessionsTotal, sessionsChecked: 0, sessionsSkipped: 0,
    chunksDiscovered: 0, cachedChunks: 0, savedVectors: 0, requestsStarted: 0, requestsCompleted: 0 };
  let stopped = false;
  const emit = (status, error) => {
    const record = { event: "session_index_progress", runId, status, ...state,
      elapsedMs: Math.round(performance.now() - started),
      ...(status === "failed" ? classifyIndexFailure(error) : {}) };
    return Promise.resolve().then(() => write(root, record)).catch(() => {});
  };
  return {
    state,
    async finish(status, error) {
      if (stopped) return;
      stopped = true;
      await emit(status, error);
    },
  };
}
