import { describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import RegistryPlansPanel from "./RegistryPlansPanel.svelte";
import { createRegistryPlansView } from "./registry-plans-view.svelte";
import panelSource from "./RegistryPlansPanel.svelte?raw";
import rowSource from "./RegistryPlanRow.svelte?raw";
import registrySource from "./RegistryPanel.svelte?raw";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";
import viewModelSource from "../app/desktop-sidebar-view-model.svelte.ts?raw";

const plans = [".pi/plans/releases/rollout.md", ".pi/plans/design/rollout.md", ".pi/plans/long-readable-plan-name.md"];

function markup(paths = plans, activePath: string | null = plans[0]!): string {
  const view = createRegistryPlansView();
  view.selectWorkspace("/project");
  return render(RegistryPlansPanel, { props: { plans: paths, activePath, view, onChoose: vi.fn() } }).body;
}

describe("persistent Registry plan navigation", () => {
  it("renders one-line plan cards without search and marks the preview selection", () => {
    const html = markup();
    expect(html).toContain('aria-label="Project plans"');
    expect(html).not.toContain("Find plan");
    expect(html).toContain(">long-readable-plan-name<");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup(plans, null)).not.toContain('aria-current="page"');
    expect(rowSource).toContain("data-plan-title-row");
    expect(rowSource).toContain("truncate");
    expect(rowSource).toContain("PlanProgressRing");
    expect(rowSource).not.toContain("TaskFieldSelect");
    expect(panelSource).not.toContain("search");
  });

  it("shows a Run icon button and moves deletion into the three-dot menu without nested buttons", () => {
    const html = markup();
    expect(html).toContain('aria-label="Run plan releases/rollout.md"');
    expect(html).toContain('aria-label="Actions for plan releases/rollout.md"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain("data-plan-menu=");
    expect(html).not.toContain('aria-label="Delete plan releases/rollout.md"');
    expect(rowSource).toContain('aria-label={`Delete plan ${label}`} disabled={actionsDisabled}');
    expect(rowSource).toContain('role="menu"');
    expect(html).toContain('title="Run plan in a new session"');
    expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
    expect(rowSource).toContain("onclick={() => onRun(plan)}");
    expect(rowSource).toContain("onclick={() => choose(() => onDelete(plan))}");
    expect(viewModelSource).toContain("options.projectActions.runPlan(path)");
    expect(viewModelSource).toContain("options.projectDocuments.removePlan(path)");
  });

  it("shows each saved plan's progress before Run and wires foreground-only refresh", () => {
    const view = createRegistryPlansView();
    const html = render(RegistryPlansPanel, { props: {
      plans, activePath: null, view, onChoose: vi.fn(),
      planProgress: { [plans[0]!]: { completed: 13, total: 17 } },
    } }).body;
    expect(html).toContain("data-plan-progress-ring");
    expect(html.indexOf("13/17")).toBeGreaterThan(0);
    expect(html.indexOf("13/17")).toBeLessThan(html.indexOf('aria-label="Run plan releases/rollout.md"'));
    expect(panelSource).toMatch(/createProjectFilesRefresh\(\(\) => onRefresh\(\), undefined, 3_000,[^;]*registry:plans-refresh[^;]*\)\.dispose/);
    expect(sidebarSource).toContain("planProgress={projectDocuments.planProgress}");
    expect(viewModelSource).toContain("onRefreshPlans: options.projectDocuments.refresh");
  });

  it("disables launch offline while leaving deletion available; disables both during another action", () => {
    const view = createRegistryPlansView();
    const props = { plans: [plans[0]!], activePath: null, view, onChoose: vi.fn() };
    const offline = render(RegistryPlansPanel, { props: { ...props, runDisabled: true } }).body;
    expect(offline).toMatch(/aria-label="Run plan [^"]+" disabled/);
    expect(offline).not.toMatch(/aria-label="Actions for plan [^"]+"[^>]*disabled/);
    const busy = render(RegistryPlansPanel, { props: { ...props, actionsDisabled: true } }).body;
    expect(busy).toMatch(/aria-label="Run plan [^"]+" disabled/);
    expect(rowSource).toContain("disabled={actionsDisabled || runDisabled}\n        onclick={() => choose(() => onResume?.(plan))}");
  });

  it("shows an empty hint when the project has no plans", () => {
    const html = markup([]);
    expect(html).toContain("data-plans-empty");
    expect(html).toContain("No plans yet");
  });

  it("keeps navigation alongside the existing Markdown preview rather than a closing popup", () => {
    // Plans live in the Work sidebar tab, not in the Registry resource catalog.
    expect(registrySource).not.toContain("RegistryPlansPanel");
    expect(registrySource).not.toContain("focusPlans");
    expect(sidebarSource).toContain('data-work-section="plans"');
    expect(sidebarSource).toContain('data-work-section="tasks"');
    expect(sidebarSource.indexOf('data-work-section="plans"')).toBeLessThan(sidebarSource.indexOf('data-work-section="tasks"'));
    expect(sidebarSource).not.toContain('aria-label="Work view"');
    expect(sidebarSource).toContain("const plansView = createRegistryPlansView()");
    expect(sidebarSource).toContain("onChoose={onOpenProjectDocument}");
    expect(sidebarSource).toContain("activePath={activeProjectDocumentPath}");
    // Virtual Wiki directories select their navigation entry; ordinary plans use the file path.
    expect(viewModelSource.replace(/\s+/g, " ")).toContain('options.preview.active?.kind === "file" ? options.preview.active.file.virtualWikiDirectory ?? options.preview.active.file.path : null');
    expect(sidebarSource).not.toContain("planSelector");
    expect(sidebarSource).toContain("void openPlansSegment()");
    expect(sidebarSource).not.toContain("focusSearch");
    expect(sidebarSource).toContain("disabled={workSectionEmpty(id)}");
    expect(sidebarSource).toContain('id === "plans" && projectDocuments.plans.length === 0');
    expect(viewModelSource).not.toContain("linkTaskPlan");
    expect(panelSource).toContain('linearFocusIndex(current, event.key, rows.length, "vertical", false)');
  });
});

describe("Registry plan view memory", () => {
  it("keeps position across same-workspace updates; resets for a different workspace", () => {
    const view = createRegistryPlansView();
    view.selectWorkspace("/one");
    view.rememberScroll("/one", 120);
    view.selectWorkspace("/one");
    expect(view.scrollTop).toBe(120);
    view.selectWorkspace("/two");
    expect(view.scrollTop).toBe(0);
    view.rememberScroll("/one", 500);
    expect(view.scrollTop).toBe(0);
  });

  it("restores on remount and releases its scroll listener", () => {
    const view = createRegistryPlansView();
    view.selectWorkspace("/one");
    const node = Object.assign(new EventTarget(), { scrollTop: 0 }) as HTMLElement;
    const action = view.restoreList(node, { workspace: "/one" });
    node.scrollTop = 130;
    node.dispatchEvent(new Event("scroll"));
    action.destroy();
    node.scrollTop = 250;
    node.dispatchEvent(new Event("scroll"));
    expect(view.scrollTop).toBe(130);
    const remounted = view.restoreList(node, { workspace: "/one" });
    expect(node.scrollTop).toBe(130);
    view.selectWorkspace("/two");
    node.scrollTop = 400;
    remounted.destroy();
    expect(view.scrollTop).toBe(0);
  });
});

describe("plan owners and runs", () => {
  function owned(owners: Record<string, string>) {
    const view = createRegistryPlansView();
    view.selectWorkspace("/project");
    return render(RegistryPlansPanel, { props: {
      plans, activePath: null, view, onChoose: vi.fn(), owners,
      runs: { [plans[0]!]: [{ sessionId: "s1", title: "Run one", launchedAt: 1, status: "done" }] },
      onOpenRun: vi.fn(),
    } }).body;
  }

  it("shows the owning task as an icon and offers no manual linking", () => {
    const html = owned({ [plans[0]!]: "T-9 Owner" });
    expect(html).toContain('aria-label="Task: T-9 Owner"');
    expect(html).not.toContain("data-plan-group");
    expect(html).not.toContain("data-plan-link");
    expect(html).not.toContain("Link to task");
  });

  function withRuns(runs: { sessionId: string; status: "running" | "done" | "failed" | "interrupted" }[]) {
    const view = createRegistryPlansView();
    view.selectWorkspace("/project");
    return render(RegistryPlansPanel, { props: {
      plans, activePath: null, view, onChoose: vi.fn(),
      runs: { [plans[0]!]: runs.map((run, index) => ({ ...run, title: `Run ${run.sessionId}`, launchedAt: 10 - index })) },
      onOpenRun: vi.fn(), onResume: vi.fn(),
    } }).body;
  }

  it("keeps the card on one line and swaps the file icon for a spinner while a run is active", () => {
    const running = withRuns([{ sessionId: "s2", status: "running" }]);
    expect(running).toContain("data-plan-running");
    expect(running).toContain("animate-spin");
    expect(running).not.toContain("data-plan-runs");
    expect(running).not.toContain("Run s2<");
    expect(withRuns([{ sessionId: "s2", status: "done" }])).not.toContain("data-plan-running");
    expect(rowSource).not.toContain("data-plan-runs");
  });

  it("offers Open session and Resume (newest unfinished run only) in the menu", () => {
    expect(rowSource).toContain("data-plan-open-session={sessionRun.sessionId}");
    expect(rowSource).toContain("runningRun ?? runs[0] ?? null");
    expect(rowSource).toContain("planRunResumable(runs[0].status) && !runningRun");
    expect(rowSource).toContain("data-plan-resume");
  });
});
