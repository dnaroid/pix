import { describe, expect, it } from "vitest";
import {
  contextUsageTone,
  dcpStatsBody,
  formatCompactTokens,
  formatResetDuration,
  modelUsageTone,
  modelUsageWindowWillExhaustBeforeReset,
} from "./runtime-status";

describe("desktop runtime status helpers", () => {
  it("matches the TUI context and remaining-limit thresholds", () => {
    expect(contextUsageTone(30)).toBe("success");
    expect(contextUsageTone(31)).toBe("warning");
    expect(contextUsageTone(51)).toBe("error");
    expect(modelUsageTone(50)).toBe("success");
    expect(modelUsageTone(49)).toBe("warning");
    expect(modelUsageTone(19)).toBe("error");
  });

  it("formats compact context values and reset durations for status chrome", () => {
    const now = Date.UTC(2026, 8, 11, 12, 0, 0);
    expect(formatCompactTokens(128_400)).toBe("128.4K");
    expect(formatCompactTokens(1_000_000)).toBe("1M");
    expect(formatResetDuration(now + 95 * 60_000, now)).toBe("1h35m");
    expect(formatResetDuration(now - 1, now)).toBe("reset");
  });

  it("keeps the TUI long-window exhaustion warning heuristic", () => {
    const now = Date.UTC(2026, 8, 11, 12, 0, 0);
    expect(modelUsageWindowWillExhaustBeforeReset({
      remainingPercent: 20,
      resetAt: now + 5 * 24 * 60 * 60_000,
      windowSeconds: 7 * 24 * 60 * 60,
      hasKnownWindowDuration: true,
    }, now)).toBe(true);
    expect(modelUsageWindowWillExhaustBeforeReset({
      remainingPercent: 90,
      resetAt: now + 5 * 24 * 60 * 60_000,
      windowSeconds: 7 * 24 * 60 * 60,
      hasKnownWindowDuration: true,
    }, now)).toBe(false);
  });

  it("removes the TUI dialog heading before rendering the desktop popover body", () => {
    expect(dcpStatsBody("DCP Session Statistics:\nTokens saved: 123")).toBe("Tokens saved: 123");
  });
});
