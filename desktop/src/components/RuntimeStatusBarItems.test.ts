import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { RuntimeStatus } from "../lib/acp-client";
import RuntimeStatusBarItems from "./RuntimeStatusBarItems.svelte";

function markup(status?: RuntimeStatus, showSkeletons = false): string {
  return render(RuntimeStatusBarItems, {
    props: { status, showSkeletons, onOpenSessionUsage: () => {} },
  }).body;
}

function waitingMarkup(status?: RuntimeStatus): string {
  return render(RuntimeStatusBarItems, {
    props: {
      status,
      onOpenSessionUsage: () => {},
      quotaWaitIndicator: { label: "Hourly limit reached · retry in 1h 12m", onReopen: () => {} },
    },
  }).body;
}

const base: RuntimeStatus = { sessionId: "test", modelUsageRefresh: "ready" };

describe("runtime status fixed telemetry slots", () => {
  it("puts a single icon after the short-window countdown without rendering the wait reason inline", () => {
    const resetAt = Date.now() + 72 * 60_000;
    const html = waitingMarkup({ ...base, modelUsage: {
      modelKey: "test", provider: "anthropic", updatedAt: Date.now(),
      hourly: { remainingPercent: 0, resetAt, windowSeconds: 18000 },
      weekly: { remainingPercent: 27, resetAt: resetAt + 86400, windowSeconds: 604800 },
    } });
    expect(html.match(/data-quota-wait-indicator/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Hourly limit reached · retry in 1h 12m"');
    expect(html).not.toContain('>Hourly limit reached');
    expect(html.indexOf("1h 12m")).toBeLessThan(html.indexOf("data-quota-wait-indicator"));
    expect(html.indexOf("data-quota-wait-indicator")).toBeLessThan(html.indexOf("27%"));
    expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
  });

  it("keeps the retry control reachable without quota telemetry and omits it when not waiting", () => {
    for (const status of [undefined, base]) {
      expect(waitingMarkup(status).match(/data-quota-wait-indicator/g)).toHaveLength(1);
      expect(markup(status)).not.toContain("data-quota-wait-indicator");
    }
    const html = waitingMarkup({ ...base, modelUsage: {
      modelKey: "test", provider: "anthropic", updatedAt: Date.now(),
      weekly: { remainingPercent: 0, resetAt: Date.now() + 86400000, windowSeconds: 604800 },
    } });
    expect(html.match(/data-quota-wait-indicator/g)).toHaveLength(1);
  });

  it("renders whole compact saved estimates consistently in the trigger and accessible description", () => {
    for (const [saved, expected] of [[168_486, "168K"], [88_800, "89K"], [999_900, "1M"], [999_900_000, "1B"]] as const) {
      const html = markup({ ...base, dcpTokensSaved: saved });
      expect(html).toContain(`saved ${expected}</span>`);
      expect(html).toContain(`DCP saved ~${expected} tokens`);
    }
  });

  it("hides zero savings without reserving an empty inline savings slot", () => {
    const html = markup({ ...base, context: { tokens: 100, contextWindow: 1000, percent: 10 }, dcpTokensSaved: 0 });
    expect(html).not.toContain("saved 0</span>");
    expect(html).not.toContain("with-savings");
    expect(html).toContain("DCP saved ~0 tokens");
    expect(markup({ ...base, dcpTokensSaved: 100 })).toContain("with-savings");
  });

  it("shows countdown before remaining percent while preserving danger colors", () => {
    const html = markup({ ...base, modelUsage: {
      modelKey: "test", provider: "anthropic", updatedAt: Date.now(),
      hourly: { remainingPercent: 0, resetAt: Date.now() + 72 * 60_000, windowSeconds: 18000 },
    } });
    expect(html.indexOf("1h 12m</span>")).toBeLessThan(html.indexOf("0%</span>"));
    expect(html).toMatch(/text-tool-error[^>]*>0%<\/span>/);
  });

  it("retains both slot layouts during loading, missing data and value changes", () => {
    for (const html of [
      markup(undefined, true),
      markup(base),
      markup({ ...base, context: { tokens: 100, contextWindow: 1000, percent: 10 }, dcpTokensSaved: 0 }),
      markup({ ...base, context: { tokens: 999, contextWindow: 1000, percent: 100 }, dcpTokensSaved: 1_000_000 }),
    ]) {
      expect(html).toContain("runtime-status-layout");
      expect(html.match(/context-status-slots/g)).toHaveLength(1);
      expect(html.match(/usage-status-slots/g)).toHaveLength(1);
      expect(html).not.toContain("ml-auto");
    }
    expect(markup(base).match(/\binvisible\b/g)).toHaveLength(2);
    expect(markup(undefined, true)).not.toContain('<button');
  });

  it("renders weekly-only usage without reserving an absent short-window slot", () => {
    const resetAt = Date.now() + 86_400_000;
    const weekly = { remainingPercent: 100, resetAt, windowSeconds: 604800 };
    const usage = { modelKey: "test", provider: "anthropic" as const, updatedAt: Date.now(), weekly };
    const weeklyOnly = markup({ ...base, modelUsage: usage });
    expect(weeklyOnly.match(/class="quota-status-slots/g)).toHaveLength(1);
    expect(weeklyOnly).not.toContain("grid-column:");
    const both = markup({ ...base, modelUsage: { ...usage, hourly: { ...weekly, remainingPercent: 9, windowSeconds: 18000 } } });
    expect(both.match(/class="quota-status-slots/g)).toHaveLength(2);
    expect(both).toContain("100%");
    expect(both).toContain("9%");
  });

  it("keeps rate identity and unknown reset in their reserved quota slot", () => {
    const html = markup({ ...base, headerUsage: {
      modelKey: "test", provider: "anthropic", updatedAt: Date.now(),
      rateWindows: [{ remainingPercent: 42, resetAt: 0, windowSeconds: 60, label: "TPM" }],
    } });
    expect(html.match(/class="quota-status-slots/g)).toHaveLength(1);
    expect(html).toContain("TPM");
    expect(html).toContain("42%");
    expect(html).not.toContain(">reset</span>");
  });
});
