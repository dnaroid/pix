import { describe, expect, it } from "vitest";
import statusBar from "./StatusBar.svelte?raw";
import runtimeStatus from "./RuntimeStatusBarItems.svelte?raw";
import observerStatus from "./ObserverStatus.svelte?raw";
import brainstormStatus from "./SessionBrainstormStatus.svelte?raw";
import activityHud from "./SessionActivityStatusHud.svelte?raw";
import providerIcon from "./ModelProviderIcon.svelte?raw";
import resetCredits from "./ResetCreditsSection.svelte?raw";
import popover from "./StatusBarPopover.svelte?raw";

const sources = {
  StatusBar: statusBar,
  RuntimeStatusBarItems: runtimeStatus,
  ObserverStatus: observerStatus,
  SessionBrainstormStatus: brainstormStatus,
  SessionActivityStatusHud: activityHud,
  ModelProviderIcon: providerIcon,
  ResetCreditsSection: resetCredits,
};

function source(name: keyof typeof sources): string {
  return sources[name];
}

describe("Status bar click surfaces", () => {
  it("keeps Observer diagnostics behind an accessible disclosure, reset on opening", () => {
    expect(observerStatus).toContain('let showDiagnostics = $state(false)');
    expect(observerStatus).toContain('aria-expanded={showDiagnostics} aria-controls={diagnosticsId}');
    expect(observerStatus).toContain('onclick={() => showDiagnostics = !showDiagnostics}');
    expect(observerStatus).toContain('Technical details');
    const detailsStart = observerStatus.indexOf('{#if showDiagnostics}');
    expect(detailsStart).toBeGreaterThan(observerStatus.indexOf('What it found'));
    for (const label of ['Check duration', 'Runtime reason', 'New turns', 'Recorded tokens', 'Local feedback']) {
      expect(observerStatus.indexOf(label)).toBeGreaterThan(detailsStart);
    }
    expect(observerStatus.slice(observerStatus.indexOf('function openPopup()'), observerStatus.indexOf('function closePopup('))).toContain('showDiagnostics = false;');
  });
  it("layers opaque runtime popovers above positioned composer content", () => {
    expect(source("StatusBar")).toMatch(/<footer class="relative z-20 /);
    expect(source("RuntimeStatusBarItems").match(/\bbg-popover\b/g)).toHaveLength(2);
    expect(source("RuntimeStatusBarItems")).not.toContain("bg-popover/");
  });

  it("places Usage left and Observer before right-hand activity, with a distinct telescope", () => {
    const status = source("StatusBar");
    expect(status.indexOf("<RuntimeStatusBarItems")).toBeLessThan(status.indexOf("<ObserverStatus"));
    expect(status.indexOf("<SessionBrainstormStatus")).toBeLessThan(status.indexOf("<ObserverStatus"));
    expect(status.indexOf("<ObserverStatus")).toBeLessThan(status.indexOf("<SessionActivityStatusHud"));
    expect(status).toContain("leadingSeparator={!!observer}");
    expect(source("ObserverStatus")).toContain('@lucide/svelte/icons/telescope');
    expect(source("ObserverStatus")).not.toContain('@lucide/svelte/icons/eye');
    expect(source("ObserverStatus")).toContain('"h-4 w-4", status.kind');
    expect(status).toContain('class="flex shrink-0 items-center gap-0.5" data-status-right');
    expect(source("SessionActivityStatusHud")).not.toContain('class="mx-1 h-3 w-px');
  });
  it("does not use browser-native tooltips anywhere in status chrome or its details", () => {
    for (const name of ["StatusBar", "RuntimeStatusBarItems", "ObserverStatus", "SessionBrainstormStatus", "SessionActivityStatusHud", "ModelProviderIcon"] as const) {
      expect(source(name), name).not.toMatch(/\btitle\s*=/);
    }
  });

  it("opens all status details only on activation, never hover or focus", () => {
    for (const content of [runtimeStatus, observerStatus, brainstormStatus, activityHud, popover]) {
      expect(content).not.toMatch(/on(?:pointerenter|mouseenter|focusin|focus)=/);
      expect(content).not.toContain("group-hover:block");
      expect(content).not.toContain("group-focus-within:block");
    }
    const observer = source("ObserverStatus");
    expect(observer).toContain("onclick={togglePopup}");
    expect(observer).toContain("if (open) closePopup(false);");
    expect(observer).toContain("region.contains(event.relatedTarget)");
    expect(observer).not.toContain("popup?.focus()");
    expect(observer.indexOf("trigger?.focus()")).toBeLessThan(observer.indexOf("open = false;", observer.indexOf("function closePopup")));
  });

  it("aligns popup lower edges with Plan, touching the trigger without a gap", () => {
    expect(source("ObserverStatus")).toContain("bottom:${position.bottom}px");
    expect(source("ObserverStatus")).not.toContain("position.bottom - 6");
    expect(popover).toContain("bottom-full");
    expect(source("RuntimeStatusBarItems").match(/bottom-full/g)).toHaveLength(2);
    expect(source("SessionActivityStatusHud")).toContain("<StatusBarPopover");
    expect(source("SessionActivityStatusHud")).toContain('"flex h-6 items-center justify-center gap-1');
    for (const name of ["ObserverStatus", "SessionBrainstormStatus", "RuntimeStatusBarItems"] as const) {
      expect(source(name)).not.toContain("pb-1.5");
    }
  });

  it("toggles details and dismisses outside or on Escape without hover timers", () => {
    const runtime = source("RuntimeStatusBarItems");
    expect(runtime).toContain("contextOpen = !contextOpen;");
    expect(runtime).toContain("if (usageOpen) {");
    expect(runtime).not.toContain("hoverDismissal");
    for (const content of [runtime, popover]) {
      expect(content).toContain('event.key === "Escape"');
      expect(content).toMatch(/onpointerdown=\{(?:closeOutside|outside)\}/);
    }
    expect(popover).toContain("open = !open;");
    expect(popover).toContain("hidden={!open}");
    expect(popover).toContain("invoker?.focus()");
    expect(statusBar.match(/\{#key observer\?\.sessionId\}/g)).toHaveLength(2);
  });

  it("adds a Session limit bar and a per-model token donut around the existing weekly calendar", () => {
    expect(source("RuntimeStatusBarItems")).toContain("<UsageLimitBars windows={popupLimitWindows}");
    expect(source("RuntimeStatusBarItems")).toContain("<QuotaResetCalendar window={modelUsage.weekly}");
    expect(source("RuntimeStatusBarItems")).toContain('=> item.label === "H"');
    expect(source("RuntimeStatusBarItems")).toContain("<ModelUsageDonut models={donutModels}");
    expect(source("RuntimeStatusBarItems")).toContain("displayModelUsage(status, now)");
    expect(source("RuntimeStatusBarItems")).not.toContain('aria-label="Model quota"');
    expect(source("RuntimeStatusBarItems")).not.toContain("<p>Cached quota from the last successful refresh");
    expect(source("RuntimeStatusBarItems")).not.toContain("<p>{limitTitle(label, window)}</p>");
  });

  it("keeps Codex reset credits separate from the weekly quota reset", () => {
    const runtime = source("RuntimeStatusBarItems");
    expect(runtime).toContain('import ResetCreditsSection from "./ResetCreditsSection.svelte"');
    expect(runtime).toContain("<ResetCreditsSection credits={modelUsage.resetCredits ?? []} availableCount={modelUsage.resetCreditsAvailableCount} {now} />");
    expect(source("ResetCreditsSection")).toContain('aria-label="Available reset credits"');
    expect(source("ResetCreditsSection")).toContain("Expires in ${formatResetDuration(credit.expiresAt, now)}");
    expect(runtime).toContain("min-h-0 overflow-y-auto overscroll-contain");
    expect(runtime.indexOf("<QuotaResetCalendar")).toBeLessThan(runtime.indexOf("<ResetCreditsSection"));
    expect(runtime.indexOf("<ResetCreditsSection")).toBeLessThan(runtime.indexOf("<ModelUsageDonut"));
    expect(runtime.indexOf("<ModelUsageDonut")).toBeLessThan(runtime.indexOf("grid-cols-[1fr_auto_auto]"));
  });

  it("limits entire status popups, including headers, to content height minus 70px", () => {
    const limit = "max-h-[max(0px,calc(100dvh-70px))]";
    expect(popover).toContain(limit);
    expect(popover).toContain("overflow-y-auto overscroll-contain");
    expect(runtimeStatus.split(limit)).toHaveLength(3);
    expect(runtimeStatus).not.toContain("640px");
    expect(brainstormStatus).not.toContain("max-h-[60vh]");
    expect(activityHud).not.toContain("max-h-[min(60vh,24rem)]");
    expect(activityHud).not.toContain("max-h-[min(40vh,18rem)]");
    expect(activityHud.split(limit)).toHaveLength(3);
    expect(activityHud).toContain("mt-1 min-h-0 overflow-y-auto overscroll-contain");
    expect(activityHud).toContain("mt-0.5 min-h-0 overflow-y-auto overscroll-contain");
  });

  it("announces Claude limits refresh once, inside its disabled refresh control", () => {
    const runtime = source("RuntimeStatusBarItems");
    expect(runtime).toContain("disabled={claudeLimitsRefreshing}");
    expect(runtime).toContain('<span role="status" aria-live="polite">{claudeLimitsRefreshing ? "Refreshing…" : "Refresh limits"}</span>');
    expect(runtime).not.toContain("Checking Claude Code login and limits…");
    expect(runtime.match(/Refreshing…/g)).toHaveLength(1);
    expect(runtime).toContain("Could not refresh Claude Code limits. Retry or check your Claude Code login.");
  });
});
