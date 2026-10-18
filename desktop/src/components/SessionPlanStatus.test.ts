import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import SessionPlanStatus from "./SessionPlanStatus.svelte";
import source from "./SessionPlanStatus.svelte?raw";
import statusBarSource from "./StatusBar.svelte?raw";

describe("status bar Executing plan chip", () => {
  it("shows the plan file progress distinct from the Steps ring", () => {
    const html = render(SessionPlanStatus, { props: { plan: { path: ".pi/plans/releases/rollout.md", progress: { completed: 4, total: 9 } } } }).body;
    expect(html).toContain("data-session-plan-status");
    expect(html).toContain('aria-label="Executing plan releases/rollout.md, 4/9 checklist items"');
    expect(html).toContain("data-plan-checklist-progress");
    expect(html).toContain("4/9");
    expect(html).not.toContain("<circle");
  });

  it("labels plans without checklist progress and avoids native tooltips", () => {
    const html = render(SessionPlanStatus, { props: { plan: { path: ".pi/plans/x.md", progress: null } } }).body;
    expect(html).toContain('aria-label="Executing plan x.md"');
    expect(html).toContain("Checklist progress unavailable");
    expect(source).not.toMatch(/\stitle=/);
    expect(source).toContain("createProjectFilesRefresh");
  });

  it("shows Task › Plan › This session breadcrumbs", () => {
    const html = render(SessionPlanStatus, { props: { plan: { path: ".pi/plans/x.md", progress: null, task: "T-1 Ship it" } } }).body;
    expect(html).toContain("data-session-plan-breadcrumbs");
    expect(html).toContain("T-1 Ship it");
    expect(html).toContain("This session");
    const bare = render(SessionPlanStatus, { props: { plan: { path: ".pi/plans/x.md", progress: null } } }).body;
    expect(bare).not.toContain("data-breadcrumb-task");
  });

  it("sits before the session activity HUD only when a plan is known", () => {
    expect(statusBarSource).toContain("{#if sessionPlan}");
    expect(statusBarSource.indexOf("<SessionPlanStatus")).toBeLessThan(statusBarSource.indexOf("<SessionActivityStatusHud"));
  });

  it("shows the run status and Resume only for a resumable run", () => {
    const plan = { path: ".pi/plans/x.md", progress: { completed: 1, total: 3 } };
    const interrupted = render(SessionPlanStatus, { props: { plan: { ...plan, status: "interrupted" as const, resumable: true }, onResume: () => {} } }).body;
    expect(interrupted).toContain('data-session-plan-run-status="interrupted"');
    expect(interrupted).toContain('aria-label="Plan run x.md, Interrupted, 1/3 checklist items"');
    expect(interrupted).toContain("data-session-plan-resume");
    const running = render(SessionPlanStatus, { props: { plan: { ...plan, status: "running" as const, resumable: false }, onResume: () => {} } }).body;
    expect(running).toContain('aria-label="Executing plan x.md, Running, 1/3 checklist items"');
    expect(running).not.toContain("data-session-plan-resume");
    const disabled = render(SessionPlanStatus, { props: { plan: { ...plan, status: "failed" as const, resumable: true }, onResume: () => {}, resumeDisabled: true } }).body;
    expect(disabled).toMatch(/data-session-plan-resume[^>]*disabled/);
  });
});
