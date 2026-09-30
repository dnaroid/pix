import { describe, expect, it } from "vitest";
import {
  formatQuotaWaitCountdown,
  formatQuotaWaitLocalDatetime,
  parseQuotaWaitDuration,
  parseQuotaWaitState,
  quotaWaitCountdownSeconds,
  quotaWaitDataFromSessionState,
  quotaWaitDatetimeDeadline,
  quotaWaitHeadline,
  quotaWaitStatusLabel,
  quotaWaitTimezoneLabel,
  quotaWaitUntilCommand,
  QUOTA_WAIT_MAX_SCHEDULE_MS,
  type QuotaWaitState,
} from "./quota-wait";
import type { SessionStateNotification } from "./session-state";

function waitState(overrides: Partial<QuotaWaitState> = {}): QuotaWaitState {
  return {
    version: 1,
    modelKey: "anthropic/claude",
    reason: "Scheduled continuation",
    window: "unknown",
    nextCheckAt: 10_000,
    autoResume: true,
    phase: "waiting",
    attempt: 0,
    ...overrides,
  };
}

function notification(data: unknown, channel = "quota-wait"): SessionStateNotification {
  return { sessionId: "session-1", channel, data };
}

describe("parseQuotaWaitState", () => {
  it("accepts a valid state and preserves the pushed phase", () => {
    const state = parseQuotaWaitState({ ...waitState({ phase: "checking" }) });
    expect(state?.phase).toBe("checking");
  });

  it("accepts timer mode with notBefore", () => {
    const state = parseQuotaWaitState(waitState({ mode: "timer", notBefore: 20_000 }));
    expect(state?.mode).toBe("timer");
    expect(state?.notBefore).toBe(20_000);
  });

  it("rejects missing and invalid fields", () => {
    const raw = (overrides: Record<string, unknown>): unknown => ({ ...waitState(), ...overrides });
    expect(parseQuotaWaitState(null)).toBeUndefined();
    expect(parseQuotaWaitState({})).toBeUndefined();
    expect(parseQuotaWaitState(raw({ version: 2 }))).toBeUndefined();
    expect(parseQuotaWaitState(raw({ modelKey: "" }))).toBeUndefined();
    expect(parseQuotaWaitState(raw({ window: "daily" }))).toBeUndefined();
    expect(parseQuotaWaitState(raw({ autoResume: "yes" }))).toBeUndefined();
    expect(parseQuotaWaitState(raw({ nextCheckAt: "soon" }))).toBeUndefined();
    expect(parseQuotaWaitState(raw({ attempt: -1 }))).toBeUndefined();
    expect(parseQuotaWaitState(raw({ phase: "idle" }))).toBeUndefined();
    expect(parseQuotaWaitState(raw({ mode: "cron" }))).toBeUndefined();
    expect(parseQuotaWaitState(raw({ notBefore: "tomorrow" }))).toBeUndefined();
    expect(parseQuotaWaitState(raw({ resetAt: Number.NaN }))).toBeUndefined();
  });
});

describe("quotaWaitDataFromSessionState", () => {
  it("parses the quota-wait channel payload", () => {
    expect(quotaWaitDataFromSessionState(notification({ state: waitState() }))).toEqual({
      state: waitState(),
    });
  });

  it("maps cleared payloads to null state and ignores non-record payloads", () => {
    expect(quotaWaitDataFromSessionState(notification({ state: null }))?.state).toBeNull();
    expect(quotaWaitDataFromSessionState(notification(undefined))).toBeUndefined();
  });

  it("ignores other channels", () => {
    expect(quotaWaitDataFromSessionState(notification({ state: waitState() }, "model-usage"))).toBeUndefined();
  });
});

describe("quotaWaitCountdownSeconds", () => {
  it("counts down to nextCheckAt for quota waits", () => {
    expect(quotaWaitCountdownSeconds(waitState({ nextCheckAt: 130_000 }), 100_000)).toBe(30);
  });

  it("counts down to notBefore for timer waits before the deadline", () => {
    const state = waitState({ mode: "timer", nextCheckAt: 105_000, notBefore: 160_000 });
    expect(quotaWaitCountdownSeconds(state, 100_000)).toBe(60);
  });

  it("never returns negative values", () => {
    expect(quotaWaitCountdownSeconds(waitState({ nextCheckAt: 50_000 }), 100_000)).toBe(0);
  });
});

describe("formatQuotaWaitCountdown", () => {
  it("formats hours, minutes, and seconds compactly", () => {
    expect(formatQuotaWaitCountdown(4320)).toBe("1h 12m 0s");
    expect(formatQuotaWaitCountdown(75)).toBe("1m 15s");
    expect(formatQuotaWaitCountdown(9)).toBe("9s");
    expect(formatQuotaWaitCountdown(0)).toBe("0s");
  });
});

describe("quotaWaitHeadline", () => {
  it("covers the wait phases", () => {
    expect(quotaWaitHeadline(waitState({ autoResume: false }), 0)).toBe("Auto-resume cancelled");
    expect(quotaWaitHeadline(waitState({ phase: "checking" }), 0)).toBe("Checking quota availability…");
    expect(quotaWaitHeadline(waitState({ phase: "resuming" }), 0)).toBe("Continuing the paused task…");
    expect(quotaWaitHeadline(waitState({ window: "hourly" }), 0)).toBe("Hourly limit reached");
    expect(quotaWaitHeadline(waitState({ window: "weekly" }), 0)).toBe("Weekly limit reached");
    expect(quotaWaitHeadline(waitState({ window: "unknown" }), 0)).toBe("Usage limit reached");
  });

  it("labels timer waits before the deadline as scheduled continuation", () => {
    const state = waitState({ mode: "timer", notBefore: 200_000 });
    expect(quotaWaitHeadline(state, 100_000)).toBe("Scheduled continuation");
    expect(quotaWaitHeadline(state, 300_000)).toBe("Usage limit reached");
  });
});

describe("quotaWaitStatusLabel", () => {
  it("keeps the countdown for active waits", () => {
    const state = waitState({ mode: "timer", notBefore: 160_000 });
    expect(quotaWaitStatusLabel(state, 100_000)).toBe("Scheduled continuation · 1m 0s");
    expect(quotaWaitStatusLabel(state, 101_000)).toBe("Scheduled continuation · 59s");
  });

  it("omits the countdown after cancellation even as time advances past the deadline", () => {
    for (const mode of ["timer", "quota"] as const) {
      const state = waitState({ mode, autoResume: false, notBefore: 160_000 });
      for (const now of [100_000, 101_000, 200_000]) {
        expect(quotaWaitStatusLabel(state, now)).toBe("Auto-resume cancelled");
      }
    }
  });
});

describe("parseQuotaWaitDuration", () => {
  it("parses additive durations", () => {
    expect(parseQuotaWaitDuration("1h20m")).toBe(4_800_000);
    expect(parseQuotaWaitDuration("45s")).toBe(45_000);
    expect(parseQuotaWaitDuration("1.5h")).toBe(5_400_000);
    expect(parseQuotaWaitDuration(" 2d ")).toBe(172_800_000);
    expect(parseQuotaWaitDuration("32d")).toBe(QUOTA_WAIT_MAX_SCHEDULE_MS);
  });

  it("rejects invalid, zero, and out-of-range durations", () => {
    expect(parseQuotaWaitDuration("")).toBeUndefined();
    expect(parseQuotaWaitDuration("0s")).toBeUndefined();
    expect(parseQuotaWaitDuration("100")).toBeUndefined();
    expect(parseQuotaWaitDuration("1x")).toBeUndefined();
    expect(parseQuotaWaitDuration("1h20")).toBeUndefined();
    expect(parseQuotaWaitDuration("33d")).toBeUndefined();
  });

  it("parses repeated units additively like /wait", () => {
    expect(parseQuotaWaitDuration("20m1h30m")).toBe(6_600_000);
  });
});

describe("quotaWaitDatetimeDeadline", () => {
  const nowMs = Date.UTC(2026, 0, 15, 12, 0, 0);

  function localInput(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  it("classifies empty input", () => {
    expect(quotaWaitDatetimeDeadline("", nowMs)).toEqual({ kind: "empty" });
    expect(quotaWaitDatetimeDeadline("  ", nowMs)).toEqual({ kind: "empty" });
  });

  it("rejects unparseable values", () => {
    expect(quotaWaitDatetimeDeadline("not-a-date", nowMs)).toEqual({ kind: "invalid" });
    expect(quotaWaitDatetimeDeadline("2026-02-30T12:00", nowMs)).toEqual({ kind: "invalid" });
    expect(quotaWaitDatetimeDeadline("2026-01-20T12:00Z", nowMs)).toEqual({ kind: "invalid" });
  });

  it("rejects past times", () => {
    const past = new Date(nowMs - 60_000);
    expect(quotaWaitDatetimeDeadline(localInput(past), nowMs)).toEqual({ kind: "past" });
  });

  it("rejects horizons beyond 32 days", () => {
    const tooFar = new Date(nowMs + QUOTA_WAIT_MAX_SCHEDULE_MS + 60_000);
    expect(quotaWaitDatetimeDeadline(localInput(tooFar), nowMs)).toEqual({ kind: "too-far" });
  });

  it("accepts a future local time up to the horizon and preserves the instant", () => {
    const target = new Date(Math.ceil((nowMs + 3_600_000) / 60_000) * 60_000);
    const result = quotaWaitDatetimeDeadline(localInput(target), nowMs);
    expect(result).toEqual({ kind: "ok", date: target });
  });
});

describe("formatQuotaWaitLocalDatetime", () => {
  it("formats local picker bounds without applying the timezone offset twice", () => {
    const date = new Date(2030, 0, 20, 12, 34);
    expect(formatQuotaWaitLocalDatetime(date.getTime())).toBe("2030-01-20T12:34");
  });
});

describe("quotaWaitUntilCommand", () => {
  it("builds a /wait until command with the exact UTC instant", () => {
    const date = new Date(Date.UTC(2026, 0, 1, 10, 30, 0, 0));
    expect(quotaWaitUntilCommand(date)).toBe("/wait until 2026-01-01T10:30:00.000Z");
  });
});

describe("quotaWaitTimezoneLabel", () => {
  it("returns a non-empty local timezone label", () => {
    const label = quotaWaitTimezoneLabel();
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
  });
});
