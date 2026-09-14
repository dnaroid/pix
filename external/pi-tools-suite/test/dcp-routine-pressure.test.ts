import { describe, expect, test } from "bun:test";
import { RoutinePressureTracker } from "../src/dcp/routine-pressure.js";
import type { CompressionBlock } from "../src/dcp/state.js";

const blocks = (ids: number[]) => ids.map((id) => ({ id, active: true }) as CompressionBlock);
const assistant = (id = "sample", stopReason = "toolUse", totalTokens = 60_000) => ({
  role: "assistant", provider: "test", model: "large", timestamp: 10, responseId: id, stopReason,
  content: [{ type: "text", text: "Completed inspection." }], usage: { totalTokens },
});

function calibrated() {
  const tracker = new RoutinePressureTracker();
  // Existing compression already removed 40k before the sampled request.
  tracker.prepare("owner", 90_000, 50_000, blocks([1]));
  tracker.beforeRequest();
  const message = assistant();
  tracker.complete(message, true);
  return { tracker, message };
}

describe("routine pressure calibration", () => {
  test("subtracts only new compression while keeping overhead and appended tail", () => {
    const { tracker, message } = calibrated();
    // +2k raw growth, +30k new savings; old 40k is not subtracted twice.
    expect(tracker.estimate("owner", 62_000, [message], 92_000, 22_000, blocks([1, 2])))
      .toEqual({ projectedTokens: 32_000, adjustmentTokens: 30_000 });
    expect(tracker.estimate("owner", 62_000, [message], 92_000, 22_000, blocks([1, 2])))
      .toEqual({ projectedTokens: 32_000, adjustmentTokens: 30_000 });
  });

  test("does not adjust an unchanged projection or infer savings from an undo", () => {
    const { tracker, message } = calibrated();
    expect(tracker.estimate("owner", 62_000, [message], 92_000, 52_000, blocks([1])).adjustmentTokens).toBe(0);
    expect(tracker.estimate("owner", 62_000, [message], 92_000, 72_000, blocks([2])).adjustmentTokens).toBe(0);
    expect(tracker.estimate("owner", 62_000, [message], 92_000, 92_000, []).projectedTokens).toBe(92_000);
  });

  test("the fresh local projection is always a floor", () => {
    const { tracker, message } = calibrated();
    expect(tracker.estimate("owner", 5_000, [message], 92_000, 22_000, blocks([1, 2])))
      .toEqual({ projectedTokens: 22_000, adjustmentTokens: 0 });
    expect(tracker.estimate("owner", null, [message], 92_000, 22_000, blocks([1, 2])))
      .toEqual({ projectedTokens: 22_000, adjustmentTokens: 0 });
  });

  test("requires the exact successful usage source, not merely a matching timestamp", () => {
    const { tracker, message } = calibrated();
    const newer = assistant("another-request");
    expect(tracker.estimate("owner", 62_000, [message, newer], 92_000, 22_000, blocks([1, 2])).adjustmentTokens).toBe(0);
    expect(tracker.estimate("owner", 62_000, [], 92_000, 22_000, blocks([1, 2])).adjustmentTokens).toBe(0);
  });

  test.each(["error", "aborted"])("a %s completion cannot supply a calibration", (stopReason: string) => {
    const tracker = new RoutinePressureTracker();
    tracker.prepare("owner", 90_000, 50_000, blocks([1]));
    tracker.beforeRequest();
    const message = assistant("failed", stopReason);
    tracker.complete(message, false);
    expect(tracker.estimate("owner", 62_000, [message], 92_000, 22_000, blocks([1, 2])).adjustmentTokens).toBe(0);
  });

  test("ambiguous requests, unsent projections and zero usage cannot supply calibration", () => {
    for (const kind of ["ambiguous", "unsent", "zero"] as const) {
      const tracker = new RoutinePressureTracker();
      tracker.prepare("owner", 90_000, 50_000, blocks([1]));
      if (kind !== "unsent") tracker.beforeRequest();
      const message = assistant("request", "toolUse", kind === "zero" ? 0 : 60_000);
      tracker.complete(message, kind !== "ambiguous");
      expect(tracker.estimate("owner", 62_000, [message], 92_000, 22_000, blocks([1, 2])).adjustmentTokens).toBe(0);
    }
  });

  test("owner/window changes and restart discard calibration", () => {
    const { tracker, message } = calibrated();
    expect(tracker.estimate("other-owner", 62_000, [message], 92_000, 22_000, blocks([1, 2])).adjustmentTokens).toBe(0);
    tracker.reset();
    expect(tracker.estimate("owner", 62_000, [message], 92_000, 22_000, blocks([1, 2])).adjustmentTokens).toBe(0);
  });
});
