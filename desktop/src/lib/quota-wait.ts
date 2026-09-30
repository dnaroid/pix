import type { SessionStateNotification } from "./session-state";

/** Session-state channel published by the bundled quota-wait extension. */
export const QUOTA_WAIT_CHANNEL = "quota-wait";

/** Widget payload shape: `{ state: null }` clears, `{ state }` updates. */
export interface QuotaWaitSessionData {
  readonly state: QuotaWaitState | null;
}

export type QuotaWaitState = {
  readonly version: 1;
  readonly modelKey: string;
  readonly reason: string;
  readonly window: "hourly" | "weekly" | "unknown";
  readonly resetAt?: number;
  readonly nextCheckAt: number;
  readonly autoResume: boolean;
  readonly phase: "waiting" | "checking" | "resuming";
  readonly attempt: number;
  readonly mode?: "quota" | "timer";
  readonly notBefore?: number;
};

const PHASES: readonly string[] = ["waiting", "checking", "resuming"];
const WINDOWS: readonly string[] = ["hourly", "weekly", "unknown"];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate a pushed quota-wait state. Mirrors the shared TUI parser
 * (`src/app/session/quota-wait.ts`), but keeps the pushed `phase` because
 * Desktop renders checking/resuming distinctly instead of forcing waiting.
 */
export function parseQuotaWaitState(value: unknown): QuotaWaitState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1
    || typeof value.modelKey !== "string" || !value.modelKey
    || typeof value.reason !== "string"
    || !WINDOWS.includes(String(value.window))
    || typeof value.autoResume !== "boolean"
    || !isFiniteNumber(value.nextCheckAt)
    || typeof value.attempt !== "number" || !Number.isSafeInteger(value.attempt) || value.attempt < 0
    || !PHASES.includes(String(value.phase))) return undefined;
  if (value.resetAt !== undefined && !isFiniteNumber(value.resetAt)) return undefined;
  if (value.mode !== undefined && value.mode !== "quota" && value.mode !== "timer") return undefined;
  if (value.notBefore !== undefined && !isFiniteNumber(value.notBefore)) return undefined;
  return {
    version: 1,
    modelKey: value.modelKey,
    reason: value.reason,
    window: value.window as QuotaWaitState["window"],
    ...(value.resetAt !== undefined ? { resetAt: value.resetAt as number } : {}),
    nextCheckAt: value.nextCheckAt,
    autoResume: value.autoResume,
    phase: value.phase as QuotaWaitState["phase"],
    attempt: value.attempt,
    ...(value.mode !== undefined ? { mode: value.mode } : {}),
    ...(value.notBefore !== undefined ? { notBefore: value.notBefore as number } : {}),
  };
}

/** Parse the `pix.session-state` quota-wait channel payload. */
export function quotaWaitDataFromSessionState(
  notification: SessionStateNotification,
): QuotaWaitSessionData | undefined {
  if (notification.channel !== QUOTA_WAIT_CHANNEL || !isRecord(notification.data)) return undefined;
  return { state: parseQuotaWaitState(notification.data.state) ?? null };
}

/** Seconds until the next scheduled check (never negative). */
export function quotaWaitCountdownSeconds(state: QuotaWaitState, now: number): number {
  const target = state.mode === "timer" && state.notBefore !== undefined && now < state.notBefore
    ? state.notBefore
    : state.nextCheckAt;
  return Math.max(0, Math.ceil((target - now) / 1000));
}

/** `1h 12m 30s`-style compact countdown; mirrors the TUI wait label. */
export function formatQuotaWaitCountdown(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return [hours > 0 ? `${hours}h` : "", minutes > 0 || hours > 0 ? `${minutes}m` : "", `${rest}s`]
    .filter(Boolean)
    .join(" ");
}

/** Popup headline for the current wait phase. */
export function quotaWaitHeadline(state: QuotaWaitState, now: number): string {
  if (!state.autoResume) return "Auto-resume cancelled";
  if (state.phase === "checking") return "Checking quota availability…";
  if (state.phase === "resuming") return "Continuing the paused task…";
  if (state.mode === "timer" && state.notBefore !== undefined && now < state.notBefore) {
    return "Scheduled continuation";
  }
  const scope = state.window === "weekly" ? "Weekly" : state.window === "hourly" ? "Hourly" : "Usage";
  return `${scope} limit reached`;
}

/** Longest schedulable continuation horizon; matches the `/wait` timer limit. */
export const QUOTA_WAIT_MAX_SCHEDULE_MS = 32 * 86_400_000;

/** Quick duration presets offered by the schedule popup. */
export const QUOTA_WAIT_DURATION_PRESETS: readonly string[] = ["20m", "1h", "1h20m", "4h"];

const DURATION_UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1000,
};

/**
 * Strict additive duration parser mirroring the `/wait` command contract
 * (`1h20m`, `45s`, `1.5h`): rejects partial matches, zero, and anything
 * outside 1s–32d.
 */
export function parseQuotaWaitDuration(input: string): number | undefined {
  const trimmed = input.trim();
  if (!/^(?:\d+(?:\.\d+)?[dhms])+$/i.test(trimmed)) return undefined;
  let duration = 0;
  for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)([dhms])/gi)) {
    duration += Number(match[1]) * DURATION_UNIT_MS[match[2]!.toLowerCase()]!;
  }
  return duration >= 1000 && duration <= QUOTA_WAIT_MAX_SCHEDULE_MS ? duration : undefined;
}

export type QuotaWaitDatetimeDeadline =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "past" }
  | { kind: "too-far" }
  | { kind: "ok"; date: Date };

/**
 * Validate a local `datetime-local` selection (`YYYY-MM-DDTHH:mm[:ss]`,
 * interpreted in the user's timezone) against the schedule rules: reject
 * unparseable values, past times, and horizons beyond 32 days.
 */
export function quotaWaitDatetimeDeadline(
  value: string,
  nowMs: number,
  maxMs: number = QUOTA_WAIT_MAX_SCHEDULE_MS,
): QuotaWaitDatetimeDeadline {
  const trimmed = value.trim();
  if (!trimmed) return { kind: "empty" };
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!parts) return { kind: "invalid" };
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return { kind: "invalid" };
  if (date.getFullYear() !== Number(parts[1]) || date.getMonth() + 1 !== Number(parts[2])
    || date.getDate() !== Number(parts[3]) || date.getHours() !== Number(parts[4])
    || date.getMinutes() !== Number(parts[5]) || date.getSeconds() !== Number(parts[6] ?? 0)) return { kind: "invalid" };
  if (date.getTime() <= nowMs) return { kind: "past" };
  if (date.getTime() > nowMs + maxMs) return { kind: "too-far" };
  return { kind: "ok", date };
}

export function formatQuotaWaitLocalDatetime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Build the `/wait until <ISO-8601 UTC instant>` command for a local
 * selection. `toISOString()` always emits the timezone (`Z`), preserving the
 * exact absolute timestamp across restarts and timezones.
 */
export function quotaWaitUntilCommand(date: Date): string {
  return `/wait until ${date.toISOString()}`;
}

/** Short local timezone label shown next to the date/time picker. */
export function quotaWaitTimezoneLabel(date = new Date()): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "shortOffset" })
    .formatToParts(date);
  const offset = parts.find((part) => part.type === "timeZoneName")?.value;
  return offset ? `${timeZone} (${offset})` : timeZone;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
