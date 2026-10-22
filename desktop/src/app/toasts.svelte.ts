/**
 * Application-wide transient notifications (toast stack) and their session
 * history (notification center). One-shot action results belong here instead
 * of ad-hoc inline status lines; persistent state and form validation stay
 * next to the control that owns them.
 */
export type ToastLevel = "success" | "info" | "warning" | "error";

export type ToastAction = {
  label: string;
  run: () => void | Promise<void>;
  /** Keep the toast open after the action runs. */
  keepOpen?: boolean;
};

export type ToastInput = {
  message: string;
  detail?: string;
  /** Short origin label shown in the toast and history, e.g. "Git". */
  source?: string;
  /** Deduplication key: a visible toast with the same key is updated in place. */
  key?: string;
  actions?: readonly ToastAction[];
  /** Auto-dismiss delay in ms; `null` keeps the toast until dismissed. */
  durationMs?: number | null;
  /** Error toasts are sent to the diagnostic logger unless the caller already logged them. */
  log?: boolean;
};

export type Toast = {
  id: number;
  level: ToastLevel;
  message: string;
  detail?: string;
  source?: string;
  key?: string;
  actions: readonly ToastAction[];
  durationMs: number | null;
  /** How many times the same keyed notification was raised while visible. */
  count: number;
  createdAt: number;
};

export type NotificationEntry = {
  id: number;
  level: ToastLevel;
  message: string;
  detail?: string;
  source?: string;
  count: number;
  createdAt: number;
  read: boolean;
};

export const DEFAULT_TOAST_DURATION_MS: Record<ToastLevel, number | null> = {
  success: 5_000,
  info: 5_000,
  warning: 8_000,
  error: null,
};

export const MAX_ACTIVE_TOASTS = 20;
export const MAX_NOTIFICATION_HISTORY = 100;

type TimerApi = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
};

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

type Countdown = { handle: unknown; remaining: number; startedAt: number };

export function createToastStore(timers: TimerApi = defaultTimers) {
  let active = $state<Toast[]>([]);
  let history = $state<NotificationEntry[]>([]);
  let paused = false;
  let nextId = 1;
  let reporter: ((error: unknown) => void) | undefined;
  const countdowns = new Map<number, Countdown>();

  function stopCountdown(id: number): void {
    const countdown = countdowns.get(id);
    if (countdown?.handle !== undefined) timers.clearTimeout(countdown.handle);
    countdowns.delete(id);
  }

  function runCountdown(id: number, remaining: number): void {
    const countdown: Countdown = { handle: undefined, remaining, startedAt: timers.now() };
    countdowns.set(id, countdown);
    if (!paused) countdown.handle = timers.setTimeout(() => expire(id), remaining);
  }

  function expire(id: number): void {
    const toast = active.find((item) => item.id === id);
    countdowns.delete(id);
    if (!toast) return;
    // Auto-hidden success/info results need no acknowledgement; warnings stay unread.
    if (toast.level === "success" || toast.level === "info") markRead(id);
    active = active.filter((item) => item.id !== id);
  }

  function updateHistory(id: number, patch: Partial<NotificationEntry>): void {
    const index = history.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const entry = { ...history[index]!, ...patch };
    history = [entry, ...history.slice(0, index), ...history.slice(index + 1)];
  }

  function show(level: ToastLevel, input: ToastInput | string): number {
    const options = typeof input === "string" ? { message: input } : input;
    const message = options.message.trim();
    if (!message) return 0;
    const durationMs = options.durationMs === undefined ? DEFAULT_TOAST_DURATION_MS[level] : options.durationMs;
    const now = timers.now();
    if (level === "error" && options.log !== false) {
      try { reporter?.(new Error(options.source ? `${options.source}: ${message}` : message)); } catch { /* Logging never changes UI behavior. */ }
    }

    const existing = options.key ? active.find((item) => item.key === options.key) : undefined;
    if (existing) {
      const updated: Toast = {
        ...existing, level, message, detail: options.detail, source: options.source,
        actions: options.actions ?? [], durationMs, count: existing.count + 1, createdAt: now,
      };
      active = [...active.filter((item) => item.id !== existing.id), updated];
      updateHistory(existing.id, { level, message, detail: options.detail, source: options.source, count: updated.count, createdAt: now, read: false });
      stopCountdown(existing.id);
      if (durationMs !== null) runCountdown(existing.id, durationMs);
      return existing.id;
    }

    const id = nextId++;
    const toast: Toast = {
      id, level, message, detail: options.detail, source: options.source, key: options.key,
      actions: options.actions ?? [], durationMs, count: 1, createdAt: now,
    };
    let nextActive = [...active, toast];
    while (nextActive.length > MAX_ACTIVE_TOASTS) {
      stopCountdown(nextActive[0]!.id);
      nextActive = nextActive.slice(1);
    }
    active = nextActive;
    history = [
      { id, level, message, detail: options.detail, source: options.source, count: 1, createdAt: now, read: false },
      ...history,
    ].slice(0, MAX_NOTIFICATION_HISTORY);
    if (durationMs !== null) runCountdown(id, durationMs);
    return id;
  }

  /** User dismissal acknowledges the notification. */
  function dismiss(id: number): void {
    stopCountdown(id);
    markRead(id);
    active = active.filter((item) => item.id !== id);
  }

  function dismissAll(): void {
    for (const toast of active) stopCountdown(toast.id);
    const ids = new Set(active.map((toast) => toast.id));
    if (history.some((entry) => ids.has(entry.id) && !entry.read)) {
      history = history.map((entry) => ids.has(entry.id) ? { ...entry, read: true } : entry);
    }
    active = [];
  }

  /** Hover/focus on the stack freezes every countdown so nothing vanishes while read. */
  function pause(): void {
    if (paused) return;
    paused = true;
    const now = timers.now();
    for (const countdown of countdowns.values()) {
      if (countdown.handle !== undefined) timers.clearTimeout(countdown.handle);
      countdown.handle = undefined;
      countdown.remaining = Math.max(0, countdown.remaining - (now - countdown.startedAt));
    }
  }

  function resume(): void {
    if (!paused) return;
    paused = false;
    for (const [id, countdown] of countdowns) runCountdown(id, countdown.remaining);
  }

  function runAction(id: number, action: ToastAction): void {
    if (!action.keepOpen) dismiss(id);
    void Promise.resolve().then(action.run).catch((error) => {
      try { reporter?.(error); } catch { /* ignore */ }
      show("error", { message: error instanceof Error ? error.message : String(error), source: "Action", log: false });
    });
  }

  function markRead(id: number): void {
    if (history.some((entry) => entry.id === id && !entry.read)) {
      history = history.map((entry) => entry.id === id ? { ...entry, read: true } : entry);
    }
  }

  function markAllRead(): void {
    if (history.some((entry) => !entry.read)) history = history.map((entry) => entry.read ? entry : { ...entry, read: true });
  }

  function clearHistory(): void {
    // Visible toasts keep their entries so dismissing them stays consistent.
    const visible = new Set(active.map((toast) => toast.id));
    history = history.filter((entry) => visible.has(entry.id));
  }

  function setReporter(next: ((error: unknown) => void) | undefined): () => void {
    reporter = next;
    return () => { if (reporter === next) reporter = undefined; };
  }

  function dispose(): void {
    for (const id of [...countdowns.keys()]) stopCountdown(id);
    active = [];
    paused = false;
  }

  return {
    get active() { return active; },
    get history() { return history; },
    get unreadCount() { return history.reduce((count, entry) => count + (entry.read ? 0 : 1), 0); },
    get unreadLevel(): ToastLevel | null {
      const unread = history.filter((entry) => !entry.read);
      if (unread.some((entry) => entry.level === "error")) return "error";
      if (unread.some((entry) => entry.level === "warning")) return "warning";
      return unread.length ? "info" : null;
    },
    show,
    success: (input: ToastInput | string) => show("success", input),
    info: (input: ToastInput | string) => show("info", input),
    warning: (input: ToastInput | string) => show("warning", input),
    error: (input: ToastInput | string) => show("error", input),
    dismiss,
    dismissAll,
    pause,
    resume,
    runAction,
    markRead,
    markAllRead,
    clearHistory,
    setReporter,
    dispose,
  };
}

export type ToastStore = ReturnType<typeof createToastStore>;

/** Shared Desktop notification stack. */
export const toasts = createToastStore();
