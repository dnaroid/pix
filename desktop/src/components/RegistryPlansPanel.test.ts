import { describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import RegistryPlansPanel from "./RegistryPlansPanel.svelte";
import { createRegistryPlansView } from "./registry-plans-view.svelte";
import panelSource from "./RegistryPlansPanel.svelte?raw";
import registrySource from "./RegistryPanel.svelte?raw";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";
import viewModelSource from "../app/desktop-sidebar-view-model.svelte.ts?raw";

const plans = [".pi/plans/releases/rollout.md", ".pi/plans/design/rollout.md", ".pi/plans/long-readable-plan-name.md"];

function markup(query = "", paths = plans, activePath: string | null = plans[0]!): string {
  const view = createRegistryPlansView();
  view.selectWorkspace("/project");
  view.search(query);
  return render(RegistryPlansPanel, { props: { plans: paths, activePath, view, onChoose: vi.fn() } }).body;
}

describe("persistent Registry plan navigation", () => {
  it("shows readable names, folder context and the actual preview selection", () => {
    const html = markup();
    expect(html).toContain('aria-label="Project plans"');
    expect(html).toContain('aria-label="Find plan"');
    expect(html).toContain("long-readable-plan-name.md");
    expect(html).toContain(">releases<");
    expect(html).toContain(">design<");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup("", plans, null)).not.toContain('aria-current="page"');
    expect(panelSource).toContain("break-words");
    expect(panelSource).not.toContain("truncate");
  });

  it("filters by path and keeps the search visible when there are no matches", () => {
    expect(markup("releases")).toContain('data-plan-path=".pi/plans/releases/rollout.md"');
    expect(markup("releases")).not.toContain('data-plan-path=".pi/plans/design/rollout.md"');
    expect(markup("releases")).toContain("1 / 3");
    expect(markup("releases")).toContain('aria-label="Clear plan search"');
    expect(markup("zzzzzzzzzz")).toContain("No matching plans");
    expect(markup("zzzzzzzzzz")).toContain('aria-label="Find plan"');
  });

  it("shows separately labelled run/delete icon buttons without nested buttons", () => {
    const html = markup();
    expect(html).toContain('aria-label="Run plan releases/rollout.md"');
    expect(html).toContain('aria-label="Delete plan releases/rollout.md"');
    expect(html).toContain('title="Run plan in a new session"');
    expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
    expect(panelSource).toContain("onclick={() => onRun(plan)}");
    expect(panelSource).toContain("onclick={() => onDelete(plan)}");
    expect(viewModelSource).toContain("options.projectActions.runPlan(path)");
    expect(viewModelSource).toContain("options.projectDocuments.removePlan(path)");
  });

  it("shows each saved plan's progress before Run and wires foreground-only refresh", () => {
    const view = createRegistryPlansView();
    const html = render(RegistryPlansPanel, { props: {
      plans, activePath: null, view, onChoose: vi.fn(),
      planProgress: { [plans[0]!]: { completed: 13, total: 17 } },
    } }).body;
    expect(html.indexOf("13/17")).toBeGreaterThan(0);
    expect(html.indexOf("13/17")).toBeLessThan(html.indexOf('aria-label="Run plan releases/rollout.md"'));
    expect(panelSource).toContain("createProjectFilesRefresh(() => onRefresh(), undefined, 3_000).dispose");
    expect(sidebarSource).toContain("planProgress={projectDocuments.planProgress}");
    expect(viewModelSource).toContain("onRefreshPlans: options.projectDocuments.refresh");
  });

  it("disables launch offline while leaving deletion available; disables both during another action", () => {
    const view = createRegistryPlansView();
    const props = { plans: [plans[0]!], activePath: null, view, onChoose: vi.fn() };
    const offline = render(RegistryPlansPanel, { props: { ...props, runDisabled: true } }).body;
    expect(offline).toMatch(/aria-label="Run plan [^"]+" disabled/);
    expect(offline).not.toMatch(/aria-label="Delete plan [^"]+" disabled/);
    const busy = render(RegistryPlansPanel, { props: { ...props, actionsDisabled: true } }).body;
    expect(busy).toMatch(/aria-label="Run plan [^"]+" disabled/);
    expect(busy).toMatch(/aria-label="Delete plan [^"]+" disabled/);
  });

  it("hides the entire section when the project has no plans, even with a retained query", () => {
    for (const query of ["", "release"]) {
      const html = markup(query, []);
      expect(html).not.toContain('aria-label="Project plans"');
      expect(html).not.toContain('aria-label="Find plan"');
      expect(html).not.toContain('aria-label="Plans"');
      expect(html).not.toContain("No matching plans");
    }
  });

  it("keeps navigation alongside the existing Markdown preview rather than a closing popup", () => {
    expect(registrySource).toContain("<RegistryPlansPanel");
    expect(sidebarSource).toContain("const plansView = createRegistryPlansView()");
    expect(sidebarSource).toContain("onChoosePlan={onOpenProjectDocument}");
    expect(sidebarSource).toContain("activePlanPath={activeProjectDocumentPath}");
    expect(viewModelSource).toContain('options.preview.active?.kind === "file" ? options.preview.active.file.path : null');
    expect(sidebarSource).not.toContain("planSelector");
    expect(sidebarSource).toContain("void registryPanel?.focusPlans()");
    expect(panelSource).toContain('linearFocusIndex(current, event.key, rows.length, "vertical", false)');
  });
});

describe("Registry plan view memory", () => {
  it("keeps query and position across same-workspace updates; resets for a different workspace", () => {
    const view = createRegistryPlansView();
    view.selectWorkspace("/one");
    view.search("rollout");
    view.rememberScroll("/one", "rollout", 120);
    view.selectWorkspace("/one");
    expect(view.query).toBe("rollout");
    expect(view.scrollTop).toBe(120);
    expect(view.visible(plans).sort()).toEqual(plans.slice(0, 2).sort());
    view.selectWorkspace("/two");
    expect(view.query).toBe("");
    expect(view.scrollTop).toBe(0);
    view.rememberScroll("/one", "rollout", 500);
    expect(view.scrollTop).toBe(0);
  });

  it("resets position only when the search changes and rejects old filter events", () => {
    const view = createRegistryPlansView();
    view.selectWorkspace("/one");
    view.rememberScroll("/one", "", 80);
    view.search("");
    expect(view.scrollTop).toBe(80);
    view.search("design");
    view.rememberScroll("/one", "", 200);
    expect(view.scrollTop).toBe(0);
    view.search("   ");
    expect(view.visible(plans)).toEqual(plans);
  });

  it("restores on remount and releases its scroll listener", () => {
    const view = createRegistryPlansView();
    view.selectWorkspace("/one");
    const node = Object.assign(new EventTarget(), { scrollTop: 0 }) as HTMLElement;
    const action = view.restoreList(node, { workspace: "/one", query: "" });
    node.scrollTop = 130;
    node.dispatchEvent(new Event("scroll"));
    action.destroy();
    node.scrollTop = 250;
    node.dispatchEvent(new Event("scroll"));
    expect(view.scrollTop).toBe(130);
    const remounted = view.restoreList(node, { workspace: "/one", query: "" });
    expect(node.scrollTop).toBe(130);
    view.search("design");
    remounted.update({ workspace: "/one", query: "design" });
    expect(node.scrollTop).toBe(0);
    view.selectWorkspace("/two");
    node.scrollTop = 400;
    remounted.destroy();
    expect(view.scrollTop).toBe(0);
  });
});
