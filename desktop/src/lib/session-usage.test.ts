import { describe, expect, it } from "vitest";
import {
  formatSessionUsageCost,
  formatSessionUsageTokens,
  providerUsageUrl,
  sortSessionUsageProviders,
} from "./session-usage";

describe("session usage presentation", () => {
  it("sorts models by descending tokens without reordering providers or mutating input", () => {
    const totals = (totalTokens: number, cost: number) => ({
      input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost,
    });
    const models = Object.freeze([
      { model: "small-expensive", totals: totals(10, 9) },
      { model: "large", totals: totals(900, 1) },
      { model: "equal", totals: totals(900, 0) },
      { model: "idle", totals: totals(0, 0) },
    ]);
    const providers = Object.freeze([
      { provider: "first", totals: totals(1810, 10), models },
      { provider: "second", totals: totals(5000, 20), models: [] },
    ]);
    const sorted = sortSessionUsageProviders(providers);
    expect(sorted.map((provider) => provider.provider)).toEqual(["first", "second"]);
    expect(sorted[0]!.models.map((model) => model.model)).toEqual(["large", "equal", "small-expensive", "idle"]);
    expect(models.map((model) => model.model)).toEqual(["small-expensive", "large", "equal", "idle"]);
    expect(sorted[0]!.totals).toBe(providers[0]!.totals);
    expect(sorted[0]!.models[0]).toBe(models[1]);
    expect(sortSessionUsageProviders(providers, "cost")[0]!.models.map((model) => model.model))
      .toEqual(["small-expensive", "large", "equal", "idle"]);
    expect(sortSessionUsageProviders(providers, "totalTokens")).toEqual(sorted);
    expect(sortSessionUsageProviders(sortSessionUsageProviders(providers, "cost"), "cost"))
      .toEqual(sortSessionUsageProviders(providers, "cost"));
  });
  it("links known subscription providers to usage pages without guessing unknown URLs", () => {
    expect(providerUsageUrl("pi-claude-code-provider")).toBe("https://claude.ai/code#settings/usage");
    expect(providerUsageUrl("openai-codex")).toBe("https://chatgpt.com/settings/usage?tab=overview");
    expect(providerUsageUrl("zai")).toBe("https://z.ai/manage-apikey/coding-plan/personal/usage");
    expect(providerUsageUrl("unknown")).toBeUndefined();
  });
  it("formats compact billing values", () => {
    expect(formatSessionUsageCost(0.034)).toBe("$0.03");
    expect(formatSessionUsageCost(0.547)).toBe("$0.55");
    expect(formatSessionUsageCost(1.234)).toBe("$1.23");
    expect(formatSessionUsageCost(0.001)).toBe("<$0.01");
    expect(formatSessionUsageCost(0)).toBe("$0.00");
    expect(formatSessionUsageTokens(67_200)).toBe("67.2K");
  });
});
