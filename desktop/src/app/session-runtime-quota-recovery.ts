const CREDENTIAL_RETRY_MS = 60_000;
const STARTUP_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

/** Owns quota retry timers and the finite per-runtime startup recovery budget. */
export function createRuntimeQuotaRecovery(refreshQuota: (sessionId: string) => void) {
  const credentialTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const startupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let startupOwners = new WeakMap<object, { attempts: number; settled: boolean }>();

  function clearTimer(timers: Map<string, ReturnType<typeof setTimeout>>, sessionId: string): void {
    const timer = timers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(sessionId);
  }

  function clearStartupQuotaRetry(sessionId: string): void {
    clearTimer(startupTimers, sessionId);
  }

  function clearModelUsageCredentialRetry(sessionId: string): void {
    clearTimer(credentialTimers, sessionId);
  }

  function startupState(owner: object) {
    let state = startupOwners.get(owner);
    if (!state) {
      state = { attempts: 0, settled: false };
      startupOwners.set(owner, state);
    }
    return state;
  }

  function settleStartupQuotaRetry(sessionId: string, owner: object): void {
    startupState(owner).settled = true;
    clearStartupQuotaRetry(sessionId);
  }

  function scheduleStartupQuotaRetry(sessionId: string, owner: object, canRetry: () => boolean): void {
    const state = startupState(owner);
    if (state.settled || startupTimers.has(sessionId)) return;
    const delay = STARTUP_RETRY_DELAYS_MS[state.attempts];
    if (delay === undefined) return;
    state.attempts += 1;
    startupTimers.set(sessionId, setTimeout(() => {
      startupTimers.delete(sessionId);
      if (canRetry()) refreshQuota(sessionId);
    }, delay));
  }

  // Missing-credential retries only read local auth until Claude refreshes it;
  // they never launch a CLI. Unlike failed I/O recovery, this cadence can persist.
  function scheduleModelUsageCredentialRetry(sessionId: string): void {
    if (credentialTimers.has(sessionId)) return;
    credentialTimers.set(sessionId, setTimeout(() => {
      credentialTimers.delete(sessionId);
      refreshQuota(sessionId);
    }, CREDENTIAL_RETRY_MS));
  }

  function forget(sessionId: string): void {
    clearModelUsageCredentialRetry(sessionId);
    clearStartupQuotaRetry(sessionId);
  }

  function reset(): void {
    for (const timer of credentialTimers.values()) clearTimeout(timer);
    for (const timer of startupTimers.values()) clearTimeout(timer);
    credentialTimers.clear();
    startupTimers.clear();
    startupOwners = new WeakMap();
  }

  return {
    clearStartupQuotaRetry, clearModelUsageCredentialRetry, settleStartupQuotaRetry,
    scheduleStartupQuotaRetry, scheduleModelUsageCredentialRetry, forget, reset,
  };
}
