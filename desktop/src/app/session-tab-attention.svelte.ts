export function createSessionTabAttentionStore() {
  let unseenCompletedSessionIds = $state<Set<string>>(new Set());

  function markCompleted(sessionId: string, visible: boolean): void {
    if (visible || unseenCompletedSessionIds.has(sessionId)) return;
    const next = new Set(unseenCompletedSessionIds);
    next.add(sessionId);
    unseenCompletedSessionIds = next;
  }

  function clear(sessionId: string): void {
    if (!unseenCompletedSessionIds.has(sessionId)) return;
    const next = new Set(unseenCompletedSessionIds);
    next.delete(sessionId);
    unseenCompletedSessionIds = next;
  }

  function reset(): void {
    unseenCompletedSessionIds = new Set();
  }

  return {
    get unseenCompletedSessionIds() { return unseenCompletedSessionIds; },
    markCompleted,
    clear,
    reset,
  };
}

export type SessionTabAttentionStore = ReturnType<typeof createSessionTabAttentionStore>;
