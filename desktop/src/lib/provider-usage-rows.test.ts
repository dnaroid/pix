import { describe, expect, it } from "vitest";
import type { UsageBucket, UsageSourceSnapshot } from "../../../acp/src/acp/usage-stats-contract";
import type { ProviderUsageEntry } from "../app/provider-usage.svelte";
import type { ModelUsageStatus, RuntimeStatus } from "./acp-client";
import { providerUsageFrequency, providerUsageOrder, providerUsageRows } from "./provider-usage-rows";

const now = 1_000_000;
const snapshot = (buckets: UsageBucket[]): UsageSourceSnapshot => ({
  source: "pix-sessions", status: "ready", unit: "tokens", coverage: null, buckets, fetchedAtMs: now,
});
const bucket = (provider: string | null, calls?: number): UsageBucket => ({
  provider, model: "model", startMs: 0, width: "hour", values: { calls },
});
const status = (provider: ModelUsageStatus["provider"], accountEmail?: string): RuntimeStatus => ({
  sessionId: "s", modelUsageRefresh: "ready", modelUsage: {
    provider, modelKey: `${provider}/model`, accountEmail, updatedAt: now,
    hourly: { remainingPercent: 42, resetAt: now + 3_600_000, windowSeconds: 18_000 },
  },
});

describe("provider usage popularity", () => {
  it("sums call counts across credential routes, projects and all available dates", () => {
    const counts = providerUsageFrequency(snapshot([
      { ...bucket("openai", 1), projectCwd: "/project-a" },
      { ...bucket("openai-codex", 4), projectCwd: "/project-b", startMs: now },
      bucket("anthropic", 10), bucket("pi-claude-code-provider", 20),
      bucket("zai", 40), bucket("zhipuai-coding-plan", 50), bucket("zhipu", 60),
      bucket("google-antigravity", 70), bucket("antigravity", 80),
    ]));
    expect([...counts]).toEqual([
      ["openai", 5], ["anthropic", 30], ["zhipu", 150], ["google-antigravity", 150],
    ]);
  });

  it("ignores unknown providers, missing/invalid calls and token/cost volume", () => {
    expect([...providerUsageFrequency(snapshot([
      bucket(null, 999), bucket("unknown", 999), bucket("constructor", 999), bucket("__proto__", 999),
      bucket("openai", NaN), bucket("openai", Infinity), bucket("openai", -1), bucket("openai", 0),
      { ...bucket("openai"), values: { totalTokens: 1e9, cost: 1e6 } },
      bucket("anthropic", 2),
    ]))]).toEqual([["anthropic", 2]]);
    expect(providerUsageFrequency(undefined).size).toBe(0);
  });

  it("sorts missing placeholders and quota charts together, most calls first", () => {
    const order = providerUsageOrder(snapshot([bucket("anthropic", 10), bucket("openai", 5)]), []);
    const rows = providerUsageRows([status("openai"), status("google-antigravity")], [
      { provider: "anthropic", modelRef: "anthropic/claude", state: "loading" },
      { provider: "openai", modelRef: "openai-codex/gpt", state: "failed" },
    ], now, order);
    expect(rows.map((row) => [row.provider, row.kind])).toEqual([
      ["anthropic", "missing"], ["openai", "quota"], ["google-antigravity", "quota"],
    ]);
  });

  it("keeps equal/unknown popularity deterministic and accounts distinct", () => {
    const statuses = [status("openai", "b@example.com"), status("anthropic"), status("openai", "a@example.com")];
    const order = providerUsageOrder(snapshot([bucket("openai", 5), bucket("anthropic", 5)]), []);
    const sorted = providerUsageRows(statuses, [], now, order);
    expect(sorted.map((row) => row.kind === "quota" ? [row.provider, row.usage.accountEmail] : null)).toEqual([
      ["anthropic", undefined], ["openai", "a@example.com"], ["openai", "b@example.com"],
    ]);
    expect(providerUsageRows([...statuses].reverse(), [], now, order)).toEqual(sorted);
    expect(providerUsageRows(statuses, [], now, [])).toEqual(sorted);
  });

  it("preserves a provider's position and row key when its quota arrives", () => {
    const entries: ProviderUsageEntry[] = [
      { provider: "anthropic", modelRef: "anthropic/claude", state: "loading" },
      { provider: "openai", modelRef: "openai/gpt", state: "unavailable" },
    ];
    const order = providerUsageOrder(snapshot([bucket("openai", 20), bucket("anthropic", 10)]), []);
    const before = providerUsageRows([], entries, now, order);
    const after = providerUsageRows([status("openai")], entries, now, order);
    expect(before.map((row) => row.key)).toEqual(after.map((row) => row.key));
    expect(after[0]?.kind).toBe("quota");
  });

  it("groups missing routes without depending on catalogue order", () => {
    const entries: ProviderUsageEntry[] = [
      { provider: "google-antigravity", modelRef: "antigravity/z", state: "loading" },
      { provider: "google-antigravity", modelRef: "antigravity/a", state: "loading" },
      { provider: "google-antigravity", modelRef: "antigravity/failed", state: "failed" },
    ];
    const rows = providerUsageRows([], entries, now, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === "missing" && rows[0].entry.modelRef).toBe("antigravity/a");
    expect(providerUsageRows([], [...entries].reverse(), now, [])).toEqual(rows);
  });

  it("retains saved order through cold, partial, stale, failed and empty history", () => {
    const saved = ["zhipu", "openai", "anthropic"];
    const partial = snapshot([bucket("anthropic", 999)]);
    for (const current of [undefined, snapshot([]), ...(["loading", "stale", "error", "unavailable"] as const)
      .map((status) => ({ ...partial, status }))]) {
      const order = providerUsageOrder(current, saved);
      expect(order).toBe(saved);
      expect(providerUsageRows([status("anthropic"), status("openai"), status("zhipu")], [], now, order)
        .map((row) => row.provider)).toEqual(saved);
    }
  });

  it("updates on complete history, preserving saved ties and unavailable providers", () => {
    const saved = ["zhipu", "openai", "anthropic", "future"];
    const current = snapshot([bucket("anthropic", 10), bucket("openai", 10), bucket("antigravity", 50)]);
    expect(providerUsageOrder(current, saved)).toEqual(["google-antigravity", "openai", "anthropic", "zhipu", "future"]);
    expect(saved).toEqual(["zhipu", "openai", "anthropic", "future"]);
  });

  it("appends newly discovered unranked providers without moving saved providers", () => {
    const order = ["zhipu", "openai"];
    const rows = providerUsageRows([status("openai"), status("anthropic"), status("google-antigravity"), status("zhipu")], [], now, order);
    expect(rows.map((row) => row.provider)).toEqual(["zhipu", "openai", "anthropic", "google-antigravity"]);
  });
});
