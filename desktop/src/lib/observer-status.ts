import type { HeadsUpSnapshot, HeadsUpLastCheck } from "./heads-up";

export type ObserverStatusKind = "off" | "checking" | "notice" | "waiting" | "limited" | "unavailable" | "error";

/** Presentation only: interval eligibility is not a promise that inference will run. */
export function observerStatus(snapshot: HeadsUpSnapshot | undefined, runtimeReady: boolean, sessionId: string | null, now = Date.now()): {
  kind: ObserverStatusKind;
  label: string;
  detail: string;
} {
  if (!sessionId) return { kind: "unavailable", label: "Observer unavailable", detail: "Open a session to use Observer." };
  if (!runtimeReady) return { kind: "unavailable", label: "Observer unavailable", detail: "Waiting for this session to connect." };
  if (!snapshot) return { kind: "unavailable", label: "Observer loading", detail: "Getting the latest Observer status…" };
  if (!snapshot.enabled || snapshot.phase === "off") return { kind: "off", label: "Observer off", detail: "Observer is disabled for this session." };
  if (snapshot.phase === "checking") return { kind: "checking", label: "Observer checking", detail: "Looking for useful things you might have missed." };
  if (snapshot.phase === "limited") {
    const expiry = snapshot.details?.windowResetsAt;
    const reason = snapshot.reason === "hourly input limit reached"
      ? "Достигнут лимит входных данных для проверок."
      : "Проверки временно приостановлены.";
    const timing = expiry != null
      ? `Ближайшее освобождение квоты: ${observerTime(expiry)}. Это не время запуска проверки или полного сброса лимита.`
      : "Время освобождения квоты неизвестно.";
    return { kind: "limited", label: "Достигнут лимит проверок", detail: `${reason} ${timing}` };
  }
  if (snapshot.notice && snapshot.notice.expiresAt > now) return { kind: "notice", label: "Observer notice", detail: snapshot.notice.title };
  if (snapshot.phase === "error" || snapshot.details?.lastCheck?.result === "error" && snapshot.reason === "check failed") return { kind: "error", label: "Observer error", detail: "The last check could not finish. You can try again with Check now." };
  if (snapshot.phase === "unavailable") return { kind: "unavailable", label: "Observer unavailable", detail: "Observer cannot run in this session right now. See technical details for the reason." };
  return { kind: "waiting", label: "Observer waiting", detail: observerWaitingReason(snapshot, now) };
}

export function observerWaitingReason(snapshot: HeadsUpSnapshot, now: number): string {
  if (snapshot.awaitingReview) return "The agent is still working. Previous findings are hidden until they can be checked again after it finishes. Check limits still apply.";
  if (snapshot.reason === "waiting for the current request to finish") return "Finishing the cancelled check before starting another one.";
  const details = snapshot.details;
  if (!details) return "Waiting for more work to review. Detailed progress is not available for this session.";
  const remaining = Math.max(0, details.config.minTurns - details.newTurns);
  const slowed = !snapshot.notice && (details.discoveryMultiplier ?? 1) > 1;
  const eligibleAt = slowed ? details.discoveryEligibleAt ?? details.intervalEligibleAt : details.intervalEligibleAt;
  const interval = now < eligibleAt;
  if (slowed && interval) return "Checking for new findings less often after your feedback. Existing findings can still be reviewed, and you can use Check now. Automatic checks also need new work.";
  if (remaining) return `Letting the agent make more progress before checking again (${remaining} more ${remaining === 1 ? "reply" : "replies"}${interval ? ", plus a short pause" : ""}).`;
  if (interval) return "Taking a short pause between checks. Another completed agent reply is also needed.";
  if (snapshot.reason === "not enough user and work context") return "There is not enough conversation or work to review yet.";
  return "Ready to review more work when the agent finishes another reply. No check is scheduled by the clock.";
}

export function observerResultLabel(check: HeadsUpLastCheck | null | undefined): string {
  if (!check) return "Not checked yet";
  const labels: Record<HeadsUpLastCheck["result"], string> = {
    running: "Checking…", none: "Nothing new to flag", notice: "A finding was shared with you",
    duplicate: "No new finding — already shared earlier", invalid: "The reply could not be used",
    error: "The check could not finish", timeout: "The check took too long", cancelled: "Check cancelled",
  };
  return labels[check.result];
}

/** Keep even a leftmost statusbar anchor within the viewport at narrow widths. */
export function observerPopoverPosition(anchor: { left: number; right: number; top: number }, width: number, height: number) {
  const popupWidth = Math.max(0, Math.min(384, width - 16));
  return {
    width: popupWidth,
    left: Math.max(8, Math.min(anchor.right - popupWidth, width - popupWidth - 8)),
    bottom: Math.max(8, height - anchor.top),
    maxHeight: Math.max(0, Math.min(height - 70, anchor.top - 8)),
  };
}

export function observerDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  return `${(ms / 1_000).toFixed(ms % 1_000 === 0 ? 0 : 1)} s`;
}

export function observerTime(ms: number | null): string {
  if (ms === null) return "Not checked";
  return new Date(ms).toLocaleString();
}
