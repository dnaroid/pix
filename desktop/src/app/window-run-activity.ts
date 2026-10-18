// Only persisted question-tool waits are recoverable across a watch restart.
export function hasRestartBlockingRun(
  runningSessionIds: ReadonlySet<string>,
  pendingBySession: ReadonlyMap<string, { kind: string }>,
  pendingUnscoped: { kind: string } | null,
  activeSessionId: string | null,
  draftSessionMaterializing: boolean,
): boolean {
  if (draftSessionMaterializing) return true;
  for (const sessionId of runningSessionIds) {
    const pending = pendingBySession.get(sessionId)
      ?? (sessionId === activeSessionId ? pendingUnscoped : null);
    if (pending?.kind !== "question") return true;
  }
  return false;
}

// Serialize IPC writes and coalesce intermediate activity updates. An older
// completion must never overwrite the current native close-warning state.
export function createWindowRunActivitySync(
  write: (running: boolean, restartBlocking: boolean) => Promise<unknown>,
  reportError: (error: unknown) => void,
) {
  let pending: { running: boolean; restartBlocking: boolean } | undefined;
  let writing = false;
  let disposed = false;

  async function flush() {
    writing = true;
    try {
      while (!disposed && pending !== undefined) {
        const activity = pending;
        pending = undefined;
        await write(activity.running, activity.restartBlocking);
      }
    } catch (error) {
      if (!disposed) reportError(error);
    } finally {
      writing = false;
      if (!disposed && pending !== undefined) void flush();
    }
  }

  return {
    update(running: boolean, restartBlocking = running) {
      if (disposed) return;
      pending = { running, restartBlocking };
      if (!writing) void flush();
    },
    dispose() { disposed = true; pending = undefined; },
  };
}
