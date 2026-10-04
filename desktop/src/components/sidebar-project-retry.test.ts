import { describe, expect, it, vi } from "vitest";
import { createSidebarProjectRetry } from "./sidebar-project-retry";

function fixture() {
  const current = { workspace: "/one", visible: false };
  const invalidateTree = vi.fn();
  const listRoot = vi.fn(async () => []);
  const reportHealth = vi.fn();
  const controller = createSidebarProjectRetry({
    workspace: () => current.workspace, visible: () => current.visible,
    invalidateTree, listRoot, reportHealth,
  });
  return { current, invalidateTree, listRoot, reportHealth, controller };
}

describe("sidebar project retry", () => {
  it("checks health without showing the explorer and invalidates its next render", async () => {
    const f = fixture();
    await f.controller.retry();
    expect(f.current.visible).toBe(false);
    expect(f.invalidateTree).toHaveBeenCalledOnce();
    expect(f.listRoot).toHaveBeenCalledOnce();
    expect(f.reportHealth).toHaveBeenCalledWith(null);
  });

  it("leaves mounted directory reload and health reporting to the explorer", async () => {
    const f = fixture();
    f.current.visible = true;
    await f.controller.retry();
    expect(f.invalidateTree).toHaveBeenCalledOnce();
    expect(f.listRoot).not.toHaveBeenCalled();
    expect(f.reportHealth).not.toHaveBeenCalled();
  });

  it("reports background listing errors instead of swallowing them", async () => {
    const f = fixture();
    f.listRoot.mockRejectedValueOnce(new Error("Permission denied"));
    await f.controller.retry();
    expect(f.reportHealth).toHaveBeenCalledWith("Permission denied");
  });

  it.each(["workspace", "round-trip", "superseded", "visible", "disposed"])("rejects a stale result after %s", async (state) => {
    const f = fixture();
    let finish!: () => void;
    f.listRoot.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve([]); }));
    const pending = f.controller.retry();
    if (state === "workspace") f.current.workspace = "/two";
    if (state === "round-trip") {
      f.controller.invalidate();
      f.current.workspace = "/two";
      f.current.workspace = "/one";
    }
    if (state === "superseded") {
      f.listRoot.mockRejectedValueOnce(new Error("new error"));
      await f.controller.retry();
      f.reportHealth.mockClear();
    }
    if (state === "visible") f.current.visible = true;
    if (state === "disposed") f.controller.dispose();
    finish();
    await pending;
    expect(f.reportHealth).not.toHaveBeenCalled();
  });
});
