import { describe, expect, it } from "vitest";
import { parseModelUsageStatus } from "./acp-response-parsers";

describe("ACP response parsers", () => {
  it("retains a summary-only credit count without inventing details", () => {
    const parsed = parseModelUsageStatus({ modelKey: "openai-codex/test", provider: "openai", updatedAt: 1, resetCreditsAvailableCount: 3 });
    expect(parsed.resetCreditsAvailableCount).toBe(3);
    expect(parsed.resetCredits).toBeUndefined();
  });

  it.each([-1, 1.5, NaN, Infinity, 1e20, "3", null])("rejects an invalid credit total %s", (resetCreditsAvailableCount) => {
    expect(() => parseModelUsageStatus({ modelKey: "openai-codex/test", provider: "openai", updatedAt: 1, resetCreditsAvailableCount }))
      .toThrow("invalid Pix model usage reset credit count");
  });
  it("parses Codex reset credits alongside ordinary model usage", () => {
    const expiresAt = Date.UTC(2026, 9, 5, 4, 19, 37);
    const parsed = parseModelUsageStatus({
      modelKey: "openai-codex/gpt-6-astra",
      provider: "openai",
      updatedAt: Date.UTC(2026, 9, 4, 20, 0, 0),
      weekly: {
        remainingPercent: 26,
        resetAt: Date.UTC(2026, 9, 9, 23, 57),
        windowSeconds: 7 * 24 * 60 * 60,
      },
      resetCredits: [
        { title: "Full reset", expiresAt },
        { title: "Reset credit" },
      ],
    });

    expect(parsed.resetCredits).toEqual([
      { title: "Full reset", expiresAt },
      { title: "Reset credit" },
    ]);
  });

  it("rejects malformed reset credits instead of trusting ACP payloads", () => {
    expect(() => parseModelUsageStatus({
      modelKey: "openai-codex/gpt-6-astra",
      provider: "openai",
      updatedAt: Date.now(),
      resetCredits: [{ title: "", expiresAt: -1 }],
    })).toThrow("invalid Pix model usage reset credit");
  });

  it.each([null, {}, [null], [{ title: "   " }], [{ title: 7 }],
    ...[NaN, Infinity, -1, 0, 1e20, "1791173977000", null].map((expiresAt) => [{ title: "Full reset", expiresAt }]),
  ].map((resetCredits) => ({ resetCredits })))("rejects invalid reset-credit payload $resetCredits", ({ resetCredits }) => {
    expect(() => parseModelUsageStatus({
      modelKey: "openai-codex/gpt-5.5", provider: "openai", updatedAt: 1, resetCredits,
    })).toThrow(/invalid Pix model usage reset credit/);
  });

  it("accepts safe additional fields, missing expiry and an empty list", () => {
    const base = { modelKey: "openai-codex/gpt-5.5", provider: "openai", updatedAt: 1 };
    expect(parseModelUsageStatus({ ...base, resetCredits: [{ title: "Full reset", futureField: true }] }).resetCredits)
      .toEqual([{ title: "Full reset" }]);
    expect(parseModelUsageStatus({ ...base, resetCredits: [] }).resetCredits).toBeUndefined();
  });
});
