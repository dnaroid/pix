export const LSP_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export interface IdleCleanupOptions {
  timeoutMs?: number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

interface Activity {
  active: number;
  cancel?: () => void;
}

function schedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export class LspIdleCleanup<T extends object> {
  private readonly entries = new Map<T, Activity>();
  private readonly timeoutMs: number;
  private readonly schedule: NonNullable<IdleCleanupOptions["schedule"]>;

  constructor(private readonly onIdle: (client: T) => void, options: IdleCleanupOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? LSP_IDLE_TIMEOUT_MS;
    this.schedule = options.schedule ?? schedule;
  }

  begin(client: T): () => void {
    let activity = this.entries.get(client);
    if (!activity) {
      activity = { active: 0 };
      this.entries.set(client, activity);
    }
    activity.cancel?.();
    activity.cancel = undefined;
    activity.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.entries.get(client) !== activity || --activity.active !== 0) return;
      const cancel = this.schedule(() => {
        // A cancelled callback may already be queued; it must not retire new work.
        if (this.entries.get(client) !== activity || activity.active !== 0 || activity.cancel !== cancel) return;
        this.entries.delete(client);
        this.onIdle(client);
      }, this.timeoutMs);
      activity.cancel = cancel;
    };
  }

  forget(client: T): void {
    this.entries.get(client)?.cancel?.();
    this.entries.delete(client);
  }

  clear(): void {
    for (const client of this.entries.keys()) this.forget(client);
  }
}
