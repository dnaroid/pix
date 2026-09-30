import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowLayoutKey } from "./window-layout-storage";
import { createSessionInspectorPreference } from "../app/session-inspector-preference.svelte";
import { createWorkspaceSidebarLayoutController } from "../components/workspace-sidebar-layout-controller.svelte";
import sidebarSource from "../components/WorkspaceSidebar.svelte?raw";
import inspectorSource from "../components/SessionInspector.svelte?raw";

const native = vi.hoisted(() => ({ label: "main", enabled: true }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: native.label }) }));

describe("per-window pane layout", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    native.label = "main";
    native.enabled = true;
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.stubGlobal("window", { innerWidth: 1240, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { documentElement: { style: {} } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("separates every pane preference by native label, including browser preview", () => {
    for (const preference of ["workspaceSidebarTab", "taskSidebarCollapsed", "taskSidebarWidth", "sessionInspectorOpen", "sessionInspectorWidth"]) {
      const mainKey = windowLayoutKey(preference);
      native.label = "project-one";
      const projectKey = windowLayoutKey(preference);
      expect(projectKey).not.toBe(mainKey);
      native.enabled = false;
      expect(windowLayoutKey(preference)).not.toBe(projectKey);
      expect(windowLayoutKey(preference)).not.toBe(mainKey);
      native.enabled = true;
      native.label = "main";
    }
    expect(sidebarSource).toContain('windowLayoutKey("workspaceSidebarTab")');
    expect(inspectorSource).toContain('windowLayoutKey("sessionInspectorWidth")');
  });

  it("retains different inspector choices across reloads without adopting shared legacy state", () => {
    values.set("pix.desktop.sessionInspectorOpen", "true");
    const main = createSessionInspectorPreference();
    main.restore();
    expect(main.open).toBe(false);
    main.setOpen(true);

    native.label = "project-one";
    const project = createSessionInspectorPreference();
    project.restore();
    expect(project.open).toBe(false);
    project.setOpen(false);
    // Existing controllers keep their identity even if a later controller is created.
    main.setOpen(true);
    project.restore();
    expect(project.open).toBe(false);
    native.label = "main";
    const reloaded = createSessionInspectorPreference();
    reloaded.restore();
    expect(reloaded.open).toBe(true);
  });

  it("restores distinct sidebar visibility and widths for two windows", () => {
    const main = createWorkspaceSidebarLayoutController({ activeTab: () => "project" });
    main.mount()();
    main.setCollapsed(true);
    main.resizeWithKeyboard({ key: "ArrowRight", preventDefault: vi.fn() } as unknown as KeyboardEvent);

    native.label = "project-one";
    const project = createWorkspaceSidebarLayoutController({ activeTab: () => "project" });
    project.mount()();
    expect(project.collapsed).toBe(false);
    expect(project.expandedWidth).toBe(296);
    project.resizeWithKeyboard({ key: "ArrowLeft", preventDefault: vi.fn() } as unknown as KeyboardEvent);

    native.label = "main";
    const reloaded = createWorkspaceSidebarLayoutController({ activeTab: () => "project" });
    reloaded.mount()();
    expect(reloaded.collapsed).toBe(true);
    expect(reloaded.expandedWidth).toBe(308);
    native.label = "project-one";
    const projectReloaded = createWorkspaceSidebarLayoutController({ activeTab: () => "project" });
    projectReloaded.mount()();
    expect(projectReloaded.collapsed).toBe(false);
    expect(projectReloaded.expandedWidth).toBe(284);
  });

  it("keeps pane controls usable when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("unavailable"); },
      setItem: () => { throw new Error("unavailable"); },
    });
    const inspector = createSessionInspectorPreference();
    inspector.restore();
    inspector.setOpen(true);
    expect(inspector.open).toBe(true);
    const sidebar = createWorkspaceSidebarLayoutController({ activeTab: () => "project" });
    sidebar.mount()();
    sidebar.setCollapsed(true);
    expect(sidebar.collapsed).toBe(true);
  });
});
