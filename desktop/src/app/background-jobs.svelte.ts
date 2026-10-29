import type { AcpClient } from "../lib/acp-client";
import { backgroundJobsSnapshot, type BackgroundJobsSnapshot } from "../lib/background-jobs";
import type { SessionStateNotification } from "../lib/session-state";

type BackgroundJobsStoreOptions = {
  client: () => AcpClient | null;
  runtimeReady: (sessionId: string) => boolean;
  reportError: (error: unknown) => void;
};

export type BackgroundJobsStore = ReturnType<typeof createBackgroundJobsStore>;

/** Per-session background shell job snapshots pushed by the suite; control goes through /background-jobs. */
export function createBackgroundJobsStore(options: BackgroundJobsStoreOptions) {
  let snapshots = $state<Map<string, BackgroundJobsSnapshot>>(new Map());
  let pending = $state<Set<string>>(new Set());
  let generation = 0;

  function handleSessionState(notification: SessionStateNotification): boolean {
    const snapshot = backgroundJobsSnapshot(notification);
    if (!snapshot) return false;
    const previous = snapshots.get(notification.sessionId);
    if (previous && previous.checkedAt > snapshot.checkedAt) return true;
    snapshots = new Map(snapshots).set(notification.sessionId, snapshot);
    return true;
  }

  async function send(sessionId: string, command: string): Promise<void> {
    const client = options.client();
    if (!client || !options.runtimeReady(sessionId)) return;
    const key = `${sessionId}\u0000${command}`;
    if (pending.has(key)) return;
    const requestGeneration = generation;
    pending = new Set(pending).add(key);
    try {
      // The extension publishes a fresh snapshot; the command reply is not state.
      await client.prompt(sessionId, [{ type: "text", text: command }]);
    } catch (error) {
      if (requestGeneration === generation && client === options.client()) options.reportError(error);
    } finally {
      if (requestGeneration === generation) {
        const next = new Set(pending);
        next.delete(key);
        pending = next;
      }
    }
  }

  function clearSession(sessionId: string): void {
    if (!snapshots.has(sessionId)) return;
    const next = new Map(snapshots);
    next.delete(sessionId);
    snapshots = next;
  }

  function reset(): void {
    generation++;
    snapshots = new Map();
    pending = new Set();
  }

  return {
    state: (sessionId: string | null) => (sessionId ? snapshots.get(sessionId) : undefined),
    isPending: (sessionId: string | null, command: string) => !!sessionId && pending.has(`${sessionId}\u0000${command}`),
    handleSessionState,
    kill: (sessionId: string, jobId: string) => send(sessionId, `/background-jobs kill ${jobId}`),
    killAll: (sessionId: string) => send(sessionId, "/background-jobs kill-all"),
    killOrphans: (sessionId: string) => send(sessionId, "/background-jobs kill-orphans"),
    clearSession,
    reset,
  };
}
