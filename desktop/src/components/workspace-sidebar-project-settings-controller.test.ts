import { describe, expect, it, vi } from "vitest";
import { createWorkspaceSidebarProjectSettingsController } from "./workspace-sidebar-project-settings-controller.svelte";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  let workspace = "/one";
  const saveProjectColor = vi.fn<() => Promise<string | undefined>>(async () => undefined);
  const closeProjectSwitcher = vi.fn();
  const controller = createWorkspaceSidebarProjectSettingsController({
    workspace: () => workspace,
    closeProjectSwitcher,
    saveProjectColor,
  });
  controller.syncWorkspace();
  return {
    controller,
    saveProjectColor,
    closeProjectSwitcher,
    setWorkspace(value: string) { workspace = value; },
  };
}

describe("project settings workspace identity", () => {
  it("gates the sidebar reset effect by workspace identity", () => {
    expect(sidebarSource).toContain("if (!projectSettingsController.syncWorkspace()) return;");
    expect(sidebarSource).not.toContain("projectSettingsController.reset()");
  });

  it("keeps settings open when background updates invalidate the same workspace", () => {
    const { controller, closeProjectSwitcher } = fixture();
    controller.show();
    expect(closeProjectSwitcher).toHaveBeenCalledOnce();
    for (let update = 0; update < 3; update++) {
      expect(controller.syncWorkspace()).toBe(false);
      expect(controller.open).toBe(true);
    }
    controller.close();
    expect(controller.open).toBe(false);
  });

  it("preserves saving guards and closes on successful save, not on prop refresh", async () => {
    const { controller, saveProjectColor } = fixture();
    const saved = deferred<string | undefined>();
    saveProjectColor.mockReturnValueOnce(saved.promise);
    controller.show();
    const pending = controller.save("#abc");
    expect(controller.syncWorkspace()).toBe(false);
    controller.close();
    expect(controller.saving).toBe(true);
    expect(controller.open).toBe(true);
    saved.resolve(undefined);
    await pending;
    expect(controller.saving).toBe(false);
    expect(controller.open).toBe(false);
  });

  it("preserves save errors across same-workspace background updates", async () => {
    const { controller, saveProjectColor, setWorkspace } = fixture();
    saveProjectColor.mockResolvedValueOnce("Config changed");
    controller.show();
    await controller.save("#abc");
    expect(controller.syncWorkspace()).toBe(false);
    expect(controller.open).toBe(true);
    expect(controller.error).toBe("Config changed");
    setWorkspace("/two");
    expect(controller.syncWorkspace()).toBe(true);
    expect(controller.open).toBe(false);
    expect(controller.error).toBeNull();
  });

  it("resets on a real project switch and ignores the previous save completion", async () => {
    const { controller, saveProjectColor, setWorkspace } = fixture();
    const oldSave = deferred<string | undefined>();
    const newSave = deferred<string | undefined>();
    saveProjectColor.mockReturnValueOnce(oldSave.promise).mockReturnValueOnce(newSave.promise);
    controller.show();
    const oldPending = controller.save("#abc");
    setWorkspace("/two");
    expect(controller.syncWorkspace()).toBe(true);
    expect(controller.open).toBe(false);
    expect(controller.saving).toBe(false);
    expect(controller.error).toBeNull();
    controller.show();
    const newPending = controller.save("#def");
    oldSave.resolve("Old workspace error");
    await oldPending;
    expect(controller.open).toBe(true);
    expect(controller.saving).toBe(true);
    expect(controller.error).toBeNull();
    newSave.resolve(undefined);
    await newPending;
    expect(controller.open).toBe(false);
    expect(controller.saving).toBe(false);
  });
});
