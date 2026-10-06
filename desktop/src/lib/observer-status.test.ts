import { describe, expect, it } from "vitest";
import { DEFAULT_HEADS_UP_CONFIG } from "../../../src/bundled-extensions/heads-up/config";
import { parseHeadsUpSnapshot, type HeadsUpSnapshot } from "./heads-up";
import { observerPopoverPosition, observerResultLabel, observerStatus, observerWaitingReason, observerTime } from "./observer-status";

function snapshot(): HeadsUpSnapshot {
  return { version: 1, instanceId: "r1", revision: 1, enabled: true, model: "provider/model", phase: "idle", checks: 0, inputTokens: 0, outputTokens: 0, notice: null,
    details: { config: { ...DEFAULT_HEADS_UP_CONFIG }, newTurns: 2, intervalEligibleAt: 60000, checksInWindow: 0, inputCharsInWindow: 0, windowResetsAt: null, lastCheck: null } };
}

describe("Observer status presentation and protocol", () => {
  it("explains reply and pause gates without presenting a scheduled check", () => {
    const state = snapshot();
    expect(observerWaitingReason({ ...state, details: { ...state.details!, newTurns: 5 } }, 60000)).toContain("1 more reply)");
    expect(observerWaitingReason({ ...state, details: { ...state.details!, newTurns: 6 } }, 0)).toContain("Another completed agent reply is also needed");
    expect(observerWaitingReason({ ...state, reason: "not enough user and work context", details: { ...state.details!, newTurns: 6 } }, 60000)).toContain("not enough conversation or work");
    expect(observerWaitingReason({ ...state, details: undefined, reason: "internal diagnostic" }, 0)).not.toContain("internal diagnostic");
  });
  it("keeps all last-check outcomes distinct without promising correctness", () => {
    const results = ["running", "none", "notice", "duplicate", "invalid", "error", "timeout", "cancelled"] as const;
    const labels = results.map(result => observerResultLabel({ startedAt: 0, finishedAt: 1, durationMs: 1, result }));
    expect(new Set(labels).size).toBe(results.length);
    expect(labels).not.toContain(observerResultLabel(null));
    expect(labels[1]).toBe("Nothing new to flag");
  });
  it("caps the full popup at window content height minus 70px", () => {
    expect(observerPopoverPosition({ left: 0, right: 30, top: 780 }, 1200, 800).maxHeight).toBe(730);
    expect(observerPopoverPosition({ left: 0, right: 30, top: 200 }, 360, 240).maxHeight).toBe(170);
    expect(observerPopoverPosition({ left: 0, right: 30, top: 20 }, 360, 30).maxHeight).toBe(0);
  });
  it("prioritizes limits over an existing notice and reports only known reservation expiry", () => {
    const state: HeadsUpSnapshot = { ...snapshot(), phase: "limited", reason: "hourly check limit reached",
      notice: { id: "n", title: "Finding", consequence: "Finding", evidence: [], createdAt: 0, expiresAt: 999999 },
      details: { ...snapshot().details!, windowResetsAt: 60000 } };
    const limited = observerStatus(state, true, "s", 0);
    expect(limited.kind).toBe("limited");
    expect(limited.label).toBe("Достигнут лимит проверок");
    expect(limited.detail).toContain(observerTime(60000));
    expect(limited.detail).toContain("не время запуска проверки или полного сброса");
    // Wall time alone cannot establish that all budget gates have cleared.
    expect(observerStatus(state, true, "s", 60001).kind).toBe("limited");
    expect(observerStatus({ ...state, phase: "idle" }, true, "s", 0).kind).toBe("notice");
    expect(observerStatus({ ...state, enabled: false }, true, "s", 0).kind).toBe("off");
    expect(observerStatus({ ...state, reason: "hourly input limit reached" }, true, "s").detail).toContain("лимит входных данных");
    expect(observerStatus({ ...state, details: undefined }, true, "s").detail).toContain("Время освобождения квоты неизвестно");
  });
  it("distinguishes off, waiting, checking, missing, limited, and errors", () => {
    const state = snapshot();
    expect(observerStatus(state, false, "s").kind).toBe("unavailable");
    expect(observerStatus(undefined, true, "s").label).toBe("Observer loading");
    expect(observerStatus(state, true, null).kind).toBe("unavailable");
    expect(observerStatus({ ...state, enabled: false }, true, "s").kind).toBe("off");
    for (const phase of ["checking", "limited", "unavailable", "error"] as const) expect(observerStatus({ ...state, phase }, true, "s").kind).toBe(phase);
    expect(observerStatus(state, true, "s", 0).detail).toContain("4 more replies, plus a short pause");
    expect(observerResultLabel(null)).toBe("Not checked yet");
    expect(observerResultLabel({ startedAt: 0, finishedAt: 1, durationMs: 1, result: "none" })).toBe("Nothing new to flag");
  });
  it("does not invent a timed launch, or mistake an expired card for a new notice", () => {
    const state = snapshot();
    expect(observerWaitingReason({ ...state, details: { ...state.details!, newTurns: 6 } }, 60000)).toContain("No check is scheduled by the clock");
    expect(observerStatus({ ...state, notice: { id: "n", title: "Old", consequence: "Old", evidence: [], createdAt: 0, expiresAt: 1 } }, true, "s", 2).kind).toBe("waiting");
  });
  it("accepts older snapshots and rejects malformed or contradictory details", () => {
    const waiting = observerStatus({ ...snapshot(), awaitingReview: true }, true, "s", 0);
    expect(waiting.kind).toBe("waiting");
    expect(waiting.detail).toContain("Previous findings are hidden");
    expect(waiting.detail).toContain("Check limits still apply");
    const current = snapshot();
    expect(parseHeadsUpSnapshot(current)).toEqual(current);
    const { details, ...legacy } = current;
    expect(parseHeadsUpSnapshot(legacy)).toEqual(legacy);
    for (const bad of [null, {}, { ...details, config: { ...details!.config, minTurns: 0 } }, { ...details, newTurns: -1 }, { ...details, extra: true },
      { ...details, lastCheck: { startedAt: 1, finishedAt: null, durationMs: null, result: "none" } },
      { ...details, lastCheck: { startedAt: 1, finishedAt: 2, durationMs: 1, result: "running" } }]) {
      expect(parseHeadsUpSnapshot({ ...current, details: bad })).toBeUndefined();
    }
  });
  it("clamps popup to the viewport at left and right edges", () => {
    for (const width of [320, 800, 1400]) {
      for (const right of [40, width - 10]) {
        const box = observerPopoverPosition({ left: right - 30, right, top: 500 }, width, 528);
        expect(box.left).toBeGreaterThanOrEqual(8);
        expect(box.left + box.width).toBeLessThanOrEqual(width - 8);
        expect(box.bottom).toBe(28);
      }
    }
  });
  it("validates local feedback and explains slower discovery without delaying hidden reviews", () => {
    const current = snapshot();
    const details = { ...current.details!, discoveryMultiplier: 4 as const, discoveryEligibleAt: 240000,
      feedback: { shown: 3, useful: 0, known: 1, irrelevant: 1, incorrect: 1, dismiss: 0 } };
    const state = { ...current, details };
    expect(parseHeadsUpSnapshot(state)).toEqual(state);
    expect(observerWaitingReason(state, 60000)).toContain("less often after your feedback");
    expect(observerWaitingReason({ ...state, awaitingReview: true }, 60000)).toContain("Previous findings are hidden");
    for (const patch of [{ discoveryMultiplier: 8 }, { discoveryEligibleAt: -1 }, { discoveryEligibleAt: undefined },
      { feedback: { ...details.feedback, incorrect: -1 } }, { feedback: { ...details.feedback, ignored: 1 } }]) {
      expect(parseHeadsUpSnapshot({ ...state, details: { ...details, ...patch } })).toBeUndefined();
    }
  });
});
