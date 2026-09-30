import type { AcpClient } from "../lib/acp-client";
import {
  quotaWaitDataFromSessionState,
  type QuotaWaitState,
} from "../lib/quota-wait";
import type { SessionStateNotification } from "../lib/session-state";

export type QuotaWaitActionCommand = "retry" | "cancel";

type QuotaWaitStoreOptions = {
  client: () => AcpClient | null;
  runtimeReady: (sessionId: string) => boolean;
  reportError: (error: unknown) => void;
};

/**
 * Desktop view of the bundled quota-wait extension state.
 *
 * The extension owns timers, persistence, and continuation; this store only
 * mirrors the pushed `quota-wait` session-state channel, keeps per-session
 * popup visibility (Hide is never reset by countdown ticks), tracks the
 * per-session schedule setup popup (opening/cancelling it never changes
 * session state), and routes popup actions plus scheduled `/wait` commands
 * through the registered extension command out-of-band, so the composer
 * draft is preserved and no synthetic user message is appended.
 */
export function createQuotaWaitStore(options: QuotaWaitStoreOptions) {
  let statesBySession = $state<Map<string, QuotaWaitState>>(new Map());
  let hiddenBySession = $state<Set<string>>(new Set());
  let scheduleOpenBySession = $state<Set<string>>(new Set());
  let nowMs = $state(Date.now());
  const pendingCommands = new Set<string>();
  let ticker: ReturnType<typeof setInterval> | undefined;

  function ensureTicker(): void {
    if (ticker !== undefined || statesBySession.size === 0) return;
    ticker = setInterval(() => { nowMs = Date.now(); }, 1000);
  }

  function stopTickerIfIdle(): void {
    if (statesBySession.size > 0 || ticker === undefined) return;
    clearInterval(ticker);
    ticker = undefined;
  }

  function closeScheduleSetup(sessionId: string): void {
    if (!scheduleOpenBySession.has(sessionId)) return;
    const next = new Set(scheduleOpenBySession);
    next.delete(sessionId);
    scheduleOpenBySession = next;
  }

  function handleSessionState(notification: SessionStateNotification): boolean {
    const data = quotaWaitDataFromSessionState(notification);
    if (!data) return false;
    const sessionId = notification.sessionId;
    if (data.state) {
      const previous = statesBySession.get(sessionId);
      if (!previous || waitIdentity(previous) !== waitIdentity(data.state)) {
        // A new wait opens the popup even if an earlier wait was hidden;
        // countdown ticks and retries of the same wait keep it hidden.
        const hidden = new Set(hiddenBySession);
        hidden.delete(sessionId);
        hiddenBySession = hidden;
      }
      // An active wait supersedes the setup popup (for example the agent hit
      // a quota error while the user was configuring a schedule).
      closeScheduleSetup(sessionId);
      const next = new Map(statesBySession);
      next.set(sessionId, data.state);
      statesBySession = next;
      ensureTicker();
    } else {
      const next = new Map(statesBySession);
      next.delete(sessionId);
      statesBySession = next;
      const hidden = new Set(hiddenBySession);
      hidden.delete(sessionId);
      hiddenBySession = hidden;
      stopTickerIfIdle();
    }
    return true;
  }

  function waitIdentity(value: QuotaWaitState): string {
    return `${value.modelKey}\u0000${value.reason}\u0000${value.mode ?? "quota"}\u0000${value.window}\u0000${value.notBefore ?? ""}`;
  }

  function state(sessionId: string | null): QuotaWaitState | undefined {
    return sessionId ? statesBySession.get(sessionId) : undefined;
  }

  function popupVisible(sessionId: string | null): QuotaWaitState | undefined {
    if (!sessionId) return undefined;
    return statesBySession.has(sessionId) && !hiddenBySession.has(sessionId)
      ? statesBySession.get(sessionId)
      : undefined;
  }

  function indicator(sessionId: string | null): QuotaWaitState | undefined {
    return state(sessionId);
  }

  function hide(sessionId: string): void {
    if (!statesBySession.has(sessionId)) return;
    const hidden = new Set(hiddenBySession);
    hidden.add(sessionId);
    hiddenBySession = hidden;
  }

  function reopen(sessionId: string): void {
    if (!hiddenBySession.has(sessionId)) return;
    const hidden = new Set(hiddenBySession);
    hidden.delete(sessionId);
    hiddenBySession = hidden;
  }

  /** Whether a wait is active and must block automatic queue drain. */
  function waiting(sessionId: string): boolean {
    return statesBySession.has(sessionId);
  }

  /** Whether the schedule setup popup is open for this session. */
  function scheduleVisible(sessionId: string | null): boolean {
    return sessionId ? scheduleOpenBySession.has(sessionId) : false;
  }

  /** Open the schedule setup popup; changes nothing until confirmed. */
  function openSchedule(sessionId: string): void {
    if (scheduleOpenBySession.has(sessionId)) return;
    const next = new Set(scheduleOpenBySession);
    next.add(sessionId);
    scheduleOpenBySession = next;
  }

  /** Cancel the schedule setup popup; no session or wait state changes. */
  function closeSchedule(sessionId: string): void {
    closeScheduleSetup(sessionId);
  }

  /**
   * Run a registered `/wait` command. The ACP side executes extension
   * commands out-of-band, so this is safe while the agent runs (the
   * extension pauses at a safe turn boundary) and never appends a synthetic
   * user message. Duplicate sends are suppressed per session.
   */
  async function sendCommand(sessionId: string, command: string): Promise<void> {
    if (pendingCommands.has(sessionId)) return;
    const requestClient = options.client();
    if (!requestClient || !options.runtimeReady(sessionId)) return;
    pendingCommands.add(sessionId);
    try {
      await requestClient.prompt(sessionId, [{ type: "text", text: command }]);
    } catch (error) {
      if (options.client() === requestClient) options.reportError(error);
    } finally {
      pendingCommands.delete(sessionId);
    }
  }

  function sendAction(sessionId: string, command: QuotaWaitActionCommand): Promise<void> {
    return sendCommand(sessionId, `/wait ${command}`);
  }

  /**
   * Confirm a schedule built by the setup popup (`/wait 1h20m`,
   * `/wait usage-reset`, `/wait until <ISO instant>`) and close it. The
   * composer draft is untouched because the command is sent out-of-band.
   * If the runtime is unavailable the popup stays open so nothing is lost.
   */
  async function submitSchedule(sessionId: string, command: string): Promise<void> {
    if (!options.client() || !options.runtimeReady(sessionId)) return;
    closeScheduleSetup(sessionId);
    reopen(sessionId);
    await sendCommand(sessionId, command);
  }

  function clearSession(sessionId: string): void {
    if (!statesBySession.has(sessionId)
      && !hiddenBySession.has(sessionId)
      && !scheduleOpenBySession.has(sessionId)) return;
    const next = new Map(statesBySession);
    next.delete(sessionId);
    statesBySession = next;
    const hidden = new Set(hiddenBySession);
    hidden.delete(sessionId);
    hiddenBySession = hidden;
    closeScheduleSetup(sessionId);
    stopTickerIfIdle();
  }

  function reset(): void {
    statesBySession = new Map();
    hiddenBySession = new Set();
    scheduleOpenBySession = new Set();
    pendingCommands.clear();
    stopTickerIfIdle();
  }

  return {
    get statesBySession() { return statesBySession; },
    get nowMs() { return nowMs; },
    handleSessionState,
    state,
    popupVisible,
    indicator,
    hide,
    reopen,
    waiting,
    scheduleVisible,
    openSchedule,
    closeSchedule,
    sendAction,
    submitSchedule,
    clearSession,
    reset,
  };
}

export type QuotaWaitStore = ReturnType<typeof createQuotaWaitStore>;
