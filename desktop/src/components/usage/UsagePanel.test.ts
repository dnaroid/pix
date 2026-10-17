import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { RuntimeStatus } from "../../lib/acp-client";
import UsagePanel from "./UsagePanel.svelte";
import UsageProviderLimits from "./UsageProviderLimits.svelte";
import UsageSection from "./UsageSection.svelte";
import UsageSourceView from "./UsageSourceView.svelte";
import type { UsageSourceSnapshot } from "../../../../acp/src/acp/usage-stats-contract";
import panelSource from "./UsagePanel.svelte?raw";
import viewSource from "./UsageSourceView.svelte?raw";
import sectionSource from "./UsageSection.svelte?raw";
import heatmapSource from "./UsageHeatmap.svelte?raw";
import barsSource from "./UsageDailyBars.svelte?raw";
import hourSource from "./UsageHourStrip.svelte?raw";
import shareSource from "./UsageShareList.svelte?raw";
import UsageTooltip from "./UsageTooltip.svelte";
import { activateOnKey } from "./usage-interaction";
import { formatCompact, formatDayKey, formatHour, formatMetric, formatRelative, localWeekStart, modelLabel, monthLabel, seriesColor, weekdayLabels } from "./usage-format";
import { OTHER_MODEL, UNATTRIBUTED_MODEL } from "../../lib/usage-stats";
import { emitUsageStatsChanged, subscribeUsageStatsChanged } from "../../lib/usage-stats-events";

describe("usage format", () => {
  it("formats compact numbers and metrics", () => {
    expect(formatCompact(950)).toBe("950");
    expect(formatCompact(12_300)).toBe("12.3K");
    expect(formatCompact(4_000_000)).toBe("4M");
    expect(formatMetric(1.234, "cost", true)).toBe("≈ $1.23");
    expect(formatMetric(0.004, "cost")).toBe("$<0.01");
    expect(formatMetric(42, "calls")).toBe("42 calls");
    expect(formatMetric(1500, "tokens")).toBe("1.5K tok");
  });

  it("labels special models and keeps Other neutral", () => {
    expect(modelLabel(OTHER_MODEL)).toBe("Other");
    expect(modelLabel(UNATTRIBUTED_MODEL)).toBe("Unattributed");
    expect(seriesColor(OTHER_MODEL, 0)).toBe("var(--tool-neutral)");
    expect(seriesColor("gpt-5", 0)).toBe("var(--tool-info)");
  });

  it("localizes weekdays, months, days and hours", () => {
    expect(weekdayLabels("en-US")).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(weekdayLabels("ru-RU")[0]).toBe("пн");
    expect(weekdayLabels("en-US", 0)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(localWeekStart("en-US")).toBe(0);
    expect(localWeekStart("ru-RU")).toBe(1);
    expect(localWeekStart("ar-EG")).toBe(6);
    expect(localWeekStart("not a locale")).toBe(1);
    expect(monthLabel(2, "en-US")).toBe("Mar");
    expect(formatDayKey("2026-03-04", "en-US")).toBe("Mar 4");
    expect(formatDayKey("2026-03-04", "ru-RU")).toMatch(/^4 мар/u);
    expect(formatHour(9, "ru-RU")).toMatch(/^0?9:00$/u);
    expect(formatHour(21, "en-US")).toMatch(/^9:00\sPM$/u);
  });

  it("formats relative time", () => {
    expect(formatRelative(0, 10_000)).toBe("just now");
    expect(formatRelative(0, 5 * 60_000)).toBe("5 min ago");
    expect(formatRelative(0, 3 * 3_600_000)).toBe("3 h ago");
  });
});

describe("usage events", () => {
  it("fans out and unsubscribes; a throwing listener does not block others", () => {
    const seen: string[] = [];
    const off1 = subscribeUsageStatsChanged(() => { throw new Error("boom"); });
    const off2 = subscribeUsageStatsChanged((n) => seen.push(n.source));
    emitUsageStatsChanged({ source: "pix-sessions" });
    off2();
    emitUsageStatsChanged({ source: "pix-sessions" });
    off1();
    expect(seen).toEqual(["pix-sessions"]);
  });
});

describe("Usage panel", () => {
  it("does not evaluate collapsed content or show its update indicator", () => {
    let rendered = 0;
    const children = (() => { rendered++; }) as never;
    const closed = render(UsageSection, { props: { title: "Sleeping", open: false, loading: true, children } }).body;
    expect(rendered).toBe(0);
    expect(closed).toContain("Sleeping");
    expect(closed).not.toContain("Updating section");
    expect(closed).not.toContain('aria-busy="true"');
    const expanded = render(UsageSection, { props: { title: "Awake", open: true, loading: true, children } }).body;
    expect(rendered).toBe(1);
    expect(expanded).toContain("Updating section");
    expect(expanded).toContain('aria-busy="true"');
  });

  it("keeps all historical disclosure headers mounted for cold, empty and populated snapshots", () => {
    const nowMs = Date.now();
    const empty: UsageSourceSnapshot = { source: "pix-sessions", status: "ready", unit: "tokens", coverage: null, buckets: [], fetchedAtMs: nowMs };
    const populated: UsageSourceSnapshot = { ...empty, buckets: [{
      startMs: nowMs, width: "hour", model: "model", provider: "anthropic", sessionId: "s", projectCwd: "/tmp/p",
      values: { totalTokens: 150, input: 100, cacheRead: 25, calls: 1 },
    }] };
    for (const snapshot of [undefined, empty, populated]) {
      const { body } = render(UsageSourceView, { props: { snapshot, period: "7d", nowMs, workspace: "/tmp/p", loading: !snapshot } });
      expect(body.match(/<details\b/gu)).toHaveLength(6);
      for (const title of ["Overview", "Activity", "Daily tokens", "By model", "Top sessions", "Cache efficiency"]) expect(body).toContain(title);
    }
    const cold = render(UsageSourceView, { props: { snapshot: undefined, period: "7d", nowMs, workspace: "/tmp/p", loading: true } }).body;
    expect(cold).toContain("Loading activity…");
    expect(cold).toContain("animate-pulse");
    const warm = render(UsageSourceView, { props: { snapshot: { ...populated, status: "stale" }, period: "7d", nowMs, workspace: "/tmp/p", loading: true } }).body;
    expect(warm).toContain("150 tok");
    expect(warm).not.toContain("Loading activity…");
    expect(warm).not.toContain("animate-pulse");
    expect(warm).not.toContain('role="status"');
  });

  it("gates shared history and provider requests on restored disclosure state", () => {
    expect(panelSource).toContain('sections.ready && sections.isOpen("provider-limits")');
    expect(panelSource).toContain('id !== "provider-limits" && sections.isOpen(id)');
    expect(panelSource).toContain("else store.close()");
    expect(panelSource).toContain("void quotas.resume()");
    expect(panelSource).toContain("else quotas.pause()");
    for (const id of ["overview", "activity", "daily", "models", "sessions", "cache"]) expect(viewSource).toContain(`isOpen("${id}")`);
    expect(panelSource).not.toContain("{#if snapshot && hasData}");
  });

  it("renders a disconnected state without fetching", () => {
    const { body } = render(UsagePanel, { props: { client: null, workspace: "/tmp/p" } });
    expect(body).toContain("Usage statistics");
    expect(body).toContain("Connect to Pix to load usage statistics.");
    expect(body).toContain("Pix usage");
    for (const label of ["OpenAI", "Anthropic", "Z.ai"]) expect(body).not.toContain(label);
  });

  it("subscribes to changes and disposes the store on teardown", () => {
    expect(panelSource).toContain("subscribeUsageStatsChanged((notification) => store.handleChanged(notification))");
    expect(panelSource).toContain("store.dispose()");
    expect(panelSource).toContain("quotas.dispose()");
    expect(panelSource).toContain("void quotas.refresh()");
    expect(panelSource).not.toContain('role="tablist"');
    expect(panelSource).toContain('store.snapshot("pix-sessions")');
    expect(panelSource).toContain("sections.dispose()");
    expect(sectionSource).toContain("sections.setOpen(sectionId, !expanded)");
    expect(sectionSource).toContain("event.preventDefault()");
    expect(sectionSource).not.toContain("ontoggle=");
  });

  it("shows the same provider hourly and weekly scales even without historical usage", () => {
    const now = Date.now();
    const { body } = render(UsageProviderLimits, { props: { statuses: [{
      sessionId: "session", modelUsageRefresh: "ready", modelUsage: {
        provider: "anthropic", modelKey: "pi-claude-code-provider/claude-opus", accountEmail: "user@example.com", updatedAt: now,
        hourly: { remainingPercent: 0, resetAt: now + 42 * 60_000, windowSeconds: 18_000, hasKnownWindowDuration: true },
        weekly: { remainingPercent: 58, resetAt: now + 4 * 86_400_000, windowSeconds: 604_800, hasKnownWindowDuration: true },
      },
    }] } });
    for (const text of ["Provider limits", "Anthropic", "user@example.com", "Hourly", "Weekly", "58%", "data-hourly-dividers", "data-quota-cycle-dates", "data-weekly-now-marker"]) {
      expect(body).toContain(text);
    }
    expect(body).not.toContain("claude-opus");
    expect(body).not.toMatch(/>Limits<|>LIMITS</u);
    expect(panelSource.indexOf("<UsageProviderLimits")).toBeLessThan(panelSource.indexOf("<UsageSourceView"));
  });

  it("uses stable disclosure ids independent of metric labels", () => {
    for (const id of ["overview", "activity", "daily", "models", "sessions", "cache"]) expect(viewSource).toContain(`sectionId="${id}"`);
    const { body } = render(UsageProviderLimits, { props: { statuses: [] } });
    expect(body).toContain("No provider limits available yet.");
    expect(body).not.toContain("data-hourly-remaining-fill");
  });

  it("shows Anthropic and Z.ai even when their quota requests are unavailable or pending", () => {
    const { body } = render(UsageProviderLimits, { props: { statuses: [], entries: [
      { provider: "anthropic", modelRef: "anthropic/claude", state: "unavailable" },
      { provider: "zhipu", modelRef: "zai/glm", state: "loading" },
    ] } });
    for (const text of ["Anthropic", "Z.ai", "Quota unavailable for this account.", "Loading limits…"]) expect(body).toContain(text);
    expect(body).not.toContain("Limits appear when a session");
  });

  it("renders a single Antigravity chart without model names or repeated headings", () => {
    const now = Date.now();
    const models = ["antigravity-claude-opus-4-6-thinking", "antigravity-claude-sonnet-4-6-thinking", "antigravity-claude-sonnet-4-6"];
    const { body } = render(UsageProviderLimits, { props: {
      statuses: models.map((model): RuntimeStatus => ({ sessionId: model, modelUsageRefresh: "ready", modelUsage: {
        provider: "google-antigravity", modelKey: `google-antigravity/${model}`, updatedAt: now,
        weekly: { remainingPercent: 100, resetAt: now + 7 * 86_400_000, windowSeconds: 604_800, hasKnownWindowDuration: true },
      } })),
      entries: [
        { provider: "google-antigravity", modelRef: "google-antigravity/another-model", state: "loading" },
        { provider: "google-antigravity", modelRef: "google-antigravity/failed-model", state: "failed" },
      ],
    } });
    expect(body.match(/>Antigravity</gu)).toHaveLength(1);
    expect(body.match(/data-usage-limit-bars/gu)).toHaveLength(1);
    expect(body.match(/data-quota-calendar/gu)).toHaveLength(1);
    for (const model of models) expect(body).not.toContain(model);
    expect(body).not.toMatch(/>Limits<|>LIMITS</u);
    expect(body).not.toContain("Loading limits…");
    expect(body).not.toContain("Could not refresh limits.");
  });

  it("groups multiple missing Antigravity models into one provider placeholder", () => {
    const { body } = render(UsageProviderLimits, { props: { statuses: [], entries: [
      { provider: "google-antigravity", modelRef: "google-antigravity/first", state: "unavailable" },
      { provider: "google-antigravity", modelRef: "google-antigravity/second", state: "loading" },
      { provider: "google-antigravity", modelRef: "google-antigravity/third", state: "failed" },
    ] } });
    expect(body.match(/>Antigravity</gu)).toHaveLength(1);
    expect(body.match(/aria-label="Loading limits…"/gu)).toHaveLength(1);
    expect(body).not.toContain("data-usage-limit-bars");
  });

  it("uses the Pix listbox and chevron disclosures, never a native select", () => {
    expect(viewSource).toContain("<TaskFieldSelect");
    expect(viewSource).not.toMatch(/<select\b/u);
    expect(sectionSource).toMatch(/<ChevronRight\b[^>]*group-open:rotate-90/u);
  });

  it("scopes to this project by default and opens only current-project top sessions", () => {
    expect(viewSource).toContain('let scope = $state<UsageScope>("project")');
    expect(viewSource).toContain('{ value: "project", label: "This project" }, { value: "all", label: "All projects" }');
    expect(panelSource).toContain("onOpenSession ? { onOpenSession }");
    expect(viewSource).toContain("{#if onOpenSession && canOpenSession(session)}");
    expect(viewSource).toContain("session.projectCwd === undefined || session.projectCwd === workspace");
  });

  it("cross-filters charts by day, hour and model; each chart ignores its own axis", () => {
    expect(viewSource).toContain("filterByTime(periodBuckets, timeFilter)");
    expect(viewSource).toContain("calendarHeatmap(byHour,");
    expect(viewSource).toContain('period === "7d" ? currentWeekWindow(nowMs, weekStart) : range');
    expect(heatmapSource).toContain("!day.outside && (day.value > 0 || day.key === selectedDay)");
    expect(viewSource).toContain("hourOfDayProfile(filterByTime(periodBuckets, { day: selectedDay })");
    expect(viewSource).toContain("modelShares(filterByTime(selectBuckets(snapshot, { ...selection, model: null }), timeFilter)");
    expect(viewSource).toContain('aria-label="Active chart filters"');
    expect(heatmapSource).toContain("onSelectDay?.(day.key === selectedDay ? null : day.key)");
    expect(barsSource).toContain("onSelectDay?.(day === selectedDay ? null : day)");
    expect(barsSource).toContain("model !== OTHER_MODEL");
    expect(hourSource).toContain("onSelectHour?.(hour === selectedHour ? null : hour)");
    expect(shareSource).toContain("share.key !== OTHER_MODEL");
    // WebKit button elements shrink-wrap flex content and collapse the bars; rows are role=button divs.
    expect(shareSource).toContain('role="button"');
    expect(shareSource).not.toMatch(/<button\b/u);
    expect(shareSource).toContain("block w-full min-w-0 cursor-pointer");
    for (const source of [heatmapSource, barsSource, hourSource]) {
      expect(source).toContain("<UsageTooltip");
      expect(source).not.toContain("<title>");
      expect(source).toContain("onfocus=");
    }
  });

  it("renders no tooltip without an anchor and activates on Enter/Space only", () => {
    const { body } = render(UsageTooltip, { props: { anchor: null, onDismiss: () => {}, children: (() => {}) as never } });
    expect(body).not.toContain('role="tooltip"');
    const calls: string[] = [];
    const key = (k: string) => ({ key: k, preventDefault: () => calls.push(`prevent:${k}`) }) as unknown as KeyboardEvent;
    activateOnKey(key("Enter"), () => calls.push("Enter"));
    activateOnKey(key(" "), () => calls.push("Space"));
    activateOnKey(key("a"), () => calls.push("a"));
    expect(calls).toEqual(["prevent:Enter", "Enter", "prevent: ", "Space"]);
  });
});
