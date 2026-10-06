import { describe, expect, it } from "vitest";
import { parseLspSnapshot, parseModelUsageStatus } from "./acp-response-parsers";

describe("ACP response parsers", () => {
  it("validates and retains LSP state, process details, and trust warnings", () => {
    expect(parseLspSnapshot({
      servers: [{ id: "ts", root: "/workspace", state: "running", pid: 42 }, { id: "rust", root: "/workspace", state: "failed", error: "exit" }],
      warnings: ["Project configuration is not trusted"],
      trustRequired: true,
    })).toEqual({
      servers: [{ id: "ts", root: "/workspace", state: "running", pid: 42 }, { id: "rust", root: "/workspace", state: "failed", error: "exit" }],
      warnings: ["Project configuration is not trusted"],
      trustRequired: true,
    });
  });
  it("keeps advisory warnings separate from trust and accepts older snapshots", () => {
    const advisory = { servers: [], warnings: ["Failed to load optional global config"] };
    expect(parseLspSnapshot({ ...advisory, trustRequired: false })).toEqual({ ...advisory, trustRequired: false });
    expect(parseLspSnapshot(advisory)).toEqual(advisory);
  });
  it.each([
    null,
    { servers: [{}], warnings: [] },
    { servers: [{ id: "x", root: "/", state: "unknown" }], warnings: [] },
    { servers: [{ id: "x", root: "/", state: "running", pid: 0 }], warnings: [] },
    { servers: [], warnings: [1] },
    { servers: [], warnings: [], trustRequired: "false" },
    { servers: [], warnings: [], trustRequired: null },
  ])("rejects malformed LSP snapshots", (snapshot) => {
    expect(() => parseLspSnapshot(snapshot)).toThrow("pix/session/lsp_control returned an invalid response");
  });

  it("retains Anthropic grant quantities and expiry over ACP", () => {
    const resetCredits = [{ title: "Full reset", count: 3, expiresAt: Date.UTC(2026, 9, 22) }];
    expect(parseModelUsageStatus({ modelKey: "pi-claude-code-provider/opus", provider: "anthropic", updatedAt: 1, resetCredits, resetCreditsAvailableCount: 3 }).resetCredits).toEqual(resetCredits);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 1e20, "3", null])("rejects an invalid grant quantity %s", (count) => {
    expect(() => parseModelUsageStatus({ modelKey: "anthropic/opus", provider: "anthropic", updatedAt: 1, resetCredits: [{ title: "Full reset", count }] })).toThrow("invalid Pix model usage reset credit quantity");
  });
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
