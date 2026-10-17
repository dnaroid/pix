import { describe, expect, it } from "vitest";
import type { ModelUsageStatus, RuntimeStatus } from "./acp-client";
import { providerUsageLimits } from "./provider-usage-limits";

const now = 1_000_000;
const hourly = { remainingPercent: 42, resetAt: now + 3_600_000, windowSeconds: 18_000 };
const usage: ModelUsageStatus = { provider: "anthropic", modelKey: "anthropic/claude", updatedAt: now, hourly };
const status = (modelUsage: ModelUsageStatus, headerUsage?: ModelUsageStatus): RuntimeStatus => ({ sessionId: "s", modelUsageRefresh: "ready", modelUsage, ...(headerUsage ? { headerUsage } : {}) });

describe("provider limit snapshots", () => {
  it("resolves model freshness then groups models by provider while keeping accounts distinct", () => {
    const result = providerUsageLimits([
      status(usage), status({ ...usage, updatedAt: now + 1, hourly: { ...hourly, remainingPercent: 10 } }),
      status({ ...usage, modelKey: "anthropic/other" }), status({ ...usage, accountEmail: "other@example.com" }),
    ], now);
    expect(result).toHaveLength(2);
    expect(result.find((entry) => !entry.accountEmail)?.hourly?.remainingPercent).toBe(10);
  });

  it("uses status-bar precedence, never reviving a quota hidden by newer header data", () => {
    expect(providerUsageLimits([status(usage, { ...usage, updatedAt: now + 1, hourly: undefined, rateWindows: [hourly] })], now)).toEqual([]);
  });

  it("expires cached windows independently and prefers fresh data on equal timestamps", () => {
    const expired = { ...hourly, resetAt: now };
    expect(providerUsageLimits([status({ ...usage, stale: true, hourly: expired })], now)).toEqual([]);
    const [entry] = providerUsageLimits([status({ ...usage, stale: true, hourly: expired, weekly: hourly })], now);
    expect(entry?.hourly).toBeUndefined();
    expect(entry?.weekly).toEqual(hourly);
    expect(providerUsageLimits([status({ ...usage, stale: true }), status(usage)], now)[0]?.stale).toBeUndefined();
  });

  it("collapses repeated Antigravity model quotas to one weekly chart", () => {
    const weekly = { remainingPercent: 100, resetAt: now + 604_800_000, windowSeconds: 604_800 };
    const snapshots = ["claude-opus-4-6-thinking", "claude-sonnet-4-6-thinking", "claude-sonnet-4-6"].map((model) => status({
      provider: "google-antigravity", modelKey: `antigravity/${model}`, updatedAt: now, weekly,
    }));
    const result = providerUsageLimits(snapshots, now);
    expect(result).toHaveLength(1);
    expect(result[0]?.weekly).toEqual(weekly);
    expect(result[0]?.iconProvider).toBe("antigravity");
    expect(result[0]).not.toHaveProperty("modelKey");
  });

  it("uses the tightest real window with its own reset rather than averaging model pools", () => {
    const first = { ...usage, modelKey: "anthropic/first", hourly: { ...hourly, remainingPercent: 20 }, weekly: { ...hourly, remainingPercent: 90 } };
    const second = { ...usage, modelKey: "anthropic/second", hourly: { ...hourly, remainingPercent: 80 }, weekly: { ...hourly, remainingPercent: 10, resetAt: now + 604_800_000 } };
    const [entry] = providerUsageLimits([status(first), status(second)], now);
    expect(entry?.hourly).toEqual(first.hourly);
    expect(entry?.weekly).toEqual(second.weekly);
    expect(entry?.stale).toBeUndefined();
    expect(providerUsageLimits([status(second), status(first)], now)).toEqual([entry]);
  });

  it("retains cached state if a selected pool is stale, and preserves account credits", () => {
    const credits = [{ title: "Reset", expiresAt: now + 86_400_000 }];
    const [entry] = providerUsageLimits([
      status({ ...usage, stale: true, hourly: { ...hourly, remainingPercent: 10 } }),
      status({ ...usage, modelKey: "anthropic/other", updatedAt: now + 1, resetCredits: credits }),
    ], now);
    expect(entry?.stale).toBe(true);
    expect(entry?.hourly?.remainingPercent).toBe(10);
    expect(entry?.resetCredits).toEqual(credits);
  });
});
