import type { HeadsUpSnapshot, HeadsUpLastCheck } from "./heads-up";

export type ObserverStatusKind = "off" | "checking" | "notice" | "waiting" | "limited" | "unavailable" | "error";

/** Presentation only: interval eligibility is not a promise that inference will run. */
export function observerStatus(snapshot: HeadsUpSnapshot | undefined, runtimeReady: boolean, sessionId: string | null, now = Date.now()): {
  kind: ObserverStatusKind;
  label: string;
  detail: string;
} {
  if (!sessionId) return { kind: "unavailable", label: "Observer unavailable", detail: "Open a session to use Observer." };
  if (!runtimeReady) return { kind: "unavailable", label: "Observer unavailable", detail: "The session runtime is not ready." };
  if (!snapshot) return { kind: "unavailable", label: "Observer loading", detail: "Waiting for the observer runtime to publish its status." };
  if (!snapshot.enabled || snapshot.phase === "off") return { kind: "off", label: "Observer off", detail: "Observer is disabled for this session." };
  if (snapshot.phase === "checking") return { kind: "checking", label: "Observer checking", detail: snapshot.reason ?? "Reviewing the latest turn." };
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
  if (snapshot.phase === "error" || snapshot.details?.lastCheck?.result === "error" && snapshot.reason === "check failed") return { kind: "error", label: "Observer error", detail: snapshot.reason ?? "Observer could not complete its last check." };
  if (snapshot.phase === "unavailable") return { kind: "unavailable", label: "Observer unavailable", detail: snapshot.reason ?? "Observer is unavailable for this runtime." };
  return { kind: "waiting", label: "Observer waiting", detail: observerWaitingReason(snapshot, now) };
}

export function observerWaitingReason(snapshot: HeadsUpSnapshot, now: number): string {
  if (snapshot.reason === "waiting for the current request to finish") return "The cancelled request is still closing. No second request will be started.";
  const details = snapshot.details;
  if (!details) return snapshot.reason ?? "Waiting for new work. This runtime does not report detailed progress.";
  const remaining = Math.max(0, details.config.minTurns - details.newTurns);
  const interval = now < details.intervalEligibleAt;
  if (remaining) return `Waiting for ${remaining} more completed agent ${remaining === 1 ? "turn" : "turns"}${interval ? " and the minimum interval" : ""}.`;
  if (interval) return "Enough new turns; waiting for the minimum interval and a completed agent turn.";
  if (snapshot.reason === "not enough user and work context") return snapshot.reason;
  return "Eligible to check at a new completed agent turn; no timed request is scheduled.";
}

export function observerResultLabel(check: HeadsUpLastCheck | null | undefined): string {
  if (!check) return "Not checked yet";
  const labels: Record<HeadsUpLastCheck["result"], string> = {
    running: "Checking", none: "No actionable findings", notice: "Finding shown",
    duplicate: "Repeated finding suppressed", invalid: "Invalid or incomplete response",
    error: "Request failed", timeout: "Request timed out", cancelled: "Cancelled",
  };
  return labels[check.result];
}

/** Keep even a leftmost statusbar anchor within the viewport at narrow widths. */
export function observerPopoverPosition(anchor: { left: number; right: number; top: number }, width: number, height: number) {
  const popupWidth = Math.max(0, Math.min(384, width - 16));
  return {
    width: popupWidth,
    left: Math.max(8, Math.min(anchor.right - popupWidth, width - popupWidth - 8)),
    bottom: Math.max(8, height - anchor.top + 6),
    maxHeight: Math.max(0, anchor.top - 14),
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
