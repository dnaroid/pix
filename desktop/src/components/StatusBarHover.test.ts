import { describe, expect, it } from "vitest";
import statusBar from "./StatusBar.svelte?raw";
import runtimeStatus from "./RuntimeStatusBarItems.svelte?raw";
import observerStatus from "./ObserverStatus.svelte?raw";
import brainstormStatus from "./SessionBrainstormStatus.svelte?raw";
import activityHud from "./SessionActivityStatusHud.svelte?raw";
import providerIcon from "./ModelProviderIcon.svelte?raw";
import resetCredits from "./ResetCreditsSection.svelte?raw";

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

describe("Status bar hover surfaces", () => {
  it("layers opaque runtime popovers above positioned composer content", () => {
    expect(source("StatusBar")).toMatch(/<footer class="relative z-20 /);
    expect(source("RuntimeStatusBarItems").match(/\bbg-popover\b/g)).toHaveLength(2);
    expect(source("RuntimeStatusBarItems")).not.toContain("bg-popover/");
  });

  it("places Usage left and Observer before right-hand activity, with a distinct binoculars", () => {
    const status = source("StatusBar");
    expect(status.indexOf("<RuntimeStatusBarItems")).toBeLessThan(status.indexOf("<ObserverStatus"));
    expect(status.indexOf("<SessionBrainstormStatus")).toBeLessThan(status.indexOf("<ObserverStatus"));
    expect(status.indexOf("<ObserverStatus")).toBeLessThan(status.indexOf("<SessionActivityStatusHud"));
    expect(status).toContain("leadingSeparator={!!observer}");
    expect(source("ObserverStatus")).toContain('@lucide/svelte/icons/binoculars');
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

  it("opens Observer idempotently without stealing focus and retains pointer/focus ownership", () => {
    const observer = source("ObserverStatus");
    expect(observer).toContain("onpointerenter={openPopup}");
    expect(observer).toContain("onfocusin={openPopup}");
    expect(observer).toContain("if (open) return;");
    expect(observer).toContain("region.contains(event.relatedTarget)");
    expect(observer).toContain("region.contains(document.activeElement)");
    expect(observer).toContain('region.matches(":hover")');
    expect(observer).not.toContain("popup?.focus()");
    expect(observer.indexOf("trigger?.focus()")).toBeLessThan(observer.indexOf("open = false;", observer.indexOf("function closePopup")));
  });

  it("aligns popup lower edges with Plan, touching the trigger without a gap", () => {
    expect(source("ObserverStatus")).toContain("bottom:${position.bottom}px");
    expect(source("ObserverStatus")).not.toContain("position.bottom - 6");
    expect(source("SessionBrainstormStatus")).toContain("bottom-full");
    expect(source("RuntimeStatusBarItems").match(/bottom-full/g)).toHaveLength(2);
    expect(source("SessionActivityStatusHud").match(/bottom-full/g)).toHaveLength(2);
    expect(source("SessionActivityStatusHud")).toContain('"flex h-6 items-center justify-center gap-1');
    for (const name of ["ObserverStatus", "SessionBrainstormStatus", "RuntimeStatusBarItems"] as const) {
      expect(source(name)).not.toContain("pb-1.5");
    }
  });

  it("allows pointer travel to runtime details without delaying explicit dismissal", () => {
    const runtime = source("RuntimeStatusBarItems");
    expect(runtime).toContain("const hoverDismissal = createHoverDismissal();");
    for (const next of ["contextOpen = true;", "if (usageOpen) return;", "contextOpen = false;\n    usageOpen = false;"]) {
      expect(runtime).toContain(`hoverDismissal.cancel();\n    ${next}`);
    }
    expect(runtime).toContain('if (event.type === "pointerleave")');
    expect(runtime).toContain("hoverDismissal.schedule(");
    expect(runtime).toContain('() => region.matches(":hover") || region.contains(document.activeElement)');
    expect(runtime).toContain("hoverDismissal.dispose();");
    expect(runtime).toContain("hoverDismissal.cancel();\n      dismiss();");
  });

  it("replaces quota prose with a separately labelled reset calendar", () => {
    expect(source("RuntimeStatusBarItems")).toContain("<QuotaResetCalendar window={modelUsage.weekly}");
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
    expect(runtime).toContain("max-h-[min(640px,calc(100vh-120px))]");
  });
});
