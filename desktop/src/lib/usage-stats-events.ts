import type { UsageStatsChangedNotification } from "../../../acp/src/acp/usage-stats-contract";

type Listener = (notification: UsageStatsChangedNotification) => void;

const listeners = new Set<Listener>();

/**
 * Window-local fan-out for `pix/usage/stats_changed`. The connection store
 * emits only for its current client; the Usage panel subscribes while
 * mounted. Each Desktop window has its own module instance.
 */
export function emitUsageStatsChanged(notification: UsageStatsChangedNotification): void {
  for (const listener of [...listeners]) {
    try {
      listener(notification);
    } catch {
      // A failing panel listener must not break ACP notification routing.
    }
  }
}

/** Subscribe; returns an idempotent unsubscribe. */
export function subscribeUsageStatsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
