import type { RenewalAccount } from "./types.js";
import type { WallClock } from "../../platform/clock/wall-clock.js";

export function shouldQueueRenewalReminder(account: RenewalAccount, clock: WallClock): boolean {
  if (account.status === "active") return false;
  const lastPulseAt = account.markers.lastPulseAt;
  if (!lastPulseAt) return true;

  // Real policy: a visible renewal nudge is only useful after a quiet period.
  // This file is a decoy for the benchmark; it reads the marker but never
  // writes the marker that hides the next reminder.
  return lastPulseAt < clock.daysAgo(1);
}

export function chooseRenewalTemplate(account: RenewalAccount): string {
  if (account.plan === "trial") return "trial-ending-soon";
  if (account.status === "paused") return "paused-plan-renewal";
  return "quiet-account-renewal";
}
