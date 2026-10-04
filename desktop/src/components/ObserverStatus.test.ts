import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import ObserverStatus from "./ObserverStatus.svelte";
import type { HeadsUpSnapshot } from "../lib/heads-up";

describe("Observer icon", () => {
  const snapshot: HeadsUpSnapshot = { version: 1, instanceId: "runtime", revision: 1, enabled: true, model: "provider/model", phase: "idle", checks: 0, inputTokens: 0, outputTokens: 0, notice: null };
  function html(patch: Partial<HeadsUpSnapshot> = {}, runtimeReady = true) {
    return render(ObserverStatus, { props: { sessionId: "session", runtimeReady, snapshot: { ...snapshot, ...patch } } }).body;
  }
  it("uses only an eye, with accessible status but no visible text or badge", () => {
    const body = html();
    expect(body).toContain('aria-label="Observer waiting"');
    expect(body).toContain("lucide-eye");
    expect(body).not.toContain("<span");
    expect(body).toContain("text-primary");
    expect(body).not.toContain("animate-pulse");
  });
  it("keeps enabled non-limited states primary and disabled/unready states grey", () => {
    for (const phase of ["idle", "error", "unavailable"] as const) expect(html({ phase })).toContain("text-primary");
    expect(html({ enabled: false, phase: "off" })).toContain("text-muted-foreground/70");
    expect(html({}, false)).toContain("text-muted-foreground/70");
  });
  it("shows a static amber eye and limit tooltip, returning to primary on recovery", () => {
    const body = html({ phase: "limited" });
    expect(body).toContain("text-tool-warning");
    expect(body).toContain('aria-label="Достигнут лимит проверок"');
    expect(body).toContain('title="Достигнут лимит проверок ·');
    expect(body).not.toContain("text-primary");
    expect(body).not.toContain("animate-pulse");
    expect(html({ phase: "idle" })).toContain("text-primary");
    expect(html({ phase: "limited", enabled: false })).toContain("text-muted-foreground/70");
    expect(html({ phase: "limited" }, false)).not.toContain("text-tool-warning");
  });
  it("pulses the eye only during a real check, respecting reduced motion", () => {
    const body = html({ phase: "checking" });
    expect(body).toContain("lucide-eye");
    expect(body).toContain("animate-pulse motion-reduce:animate-none");
    expect(body).not.toContain("animate-spin");
    expect(html({ phase: "checking", enabled: false })).not.toContain("animate-pulse");
  });
});
