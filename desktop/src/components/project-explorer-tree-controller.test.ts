import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectExplorerTreeController } from "./project-explorer-tree-controller.svelte";

const deferredTick = vi.hoisted(() => ({ wait: Promise.resolve() }));
vi.mock("svelte", async (importOriginal) => ({
  ...await importOriginal<typeof import("svelte")>(),
  tick: () => deferredTick.wait,
}));

function fixture() {
  let workspace = "/first";
  let release!: () => void;
  deferredTick.wait = new Promise<void>((resolve) => { release = resolve; });
  const focus = vi.fn();
  const root = { querySelector: vi.fn(() => ({ focus, scrollIntoView: vi.fn() })) };
  const controller = createProjectExplorerTreeController({
    workspace: () => workspace,
    refreshKey: () => 0,
    root: () => root as unknown as HTMLDivElement,
    onListDirectory: async () => [],
    onOpenFile: vi.fn(),
    onOpenExternal: vi.fn(),
    onHealthChange: vi.fn(),
    onLoadExpandedDirectories: async () => [],
    onPersistExpandedDirectories: async () => {},
    clearDrag: vi.fn(),
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  return { controller, root, focus, release, replaceWorkspace: () => { workspace = "/second"; } };
}

afterEach(() => vi.unstubAllGlobals());

describe("Project Explorer deferred focus", () => {
  it("does not focus a matching row in a replacement workspace after tick", async () => {
    const f = fixture();
    const pending = f.controller.focusPath("");
    f.replaceWorkspace();
    f.release();
    await pending;
    expect(f.root.querySelector).not.toHaveBeenCalled();
  });

  it("does not focus after teardown or after focus moves to another row", async () => {
    for (const teardown of [true, false]) {
      const f = fixture();
      const pending = f.controller.focusPath("");
      if (teardown) f.controller.dispose();
      else f.controller.state.focusedPath = "another";
      f.release();
      await pending;
      expect(f.root.querySelector).not.toHaveBeenCalled();
    }
  });

  it("still focuses a current row after rendering", async () => {
    const f = fixture();
    const pending = f.controller.focusPath("");
    expect(f.focus).not.toHaveBeenCalled();
    f.release();
    await pending;
    expect(f.focus).toHaveBeenCalledOnce();
  });
});
