import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceSidebarIndicatorActions } from "./workspace-sidebar-indicator-actions";
import type { SidebarIndicatorReasonMap } from "../lib/sidebar-indicator-types";

function fixture() {
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("document", { activeElement: null });
  const current = { workspace: "/project/a", enabled: true, reasons: {
    idx: [{ id: "idx.dirty", tone: "warning", reason: "Knowledge review is dirty" }],
  } as SidebarIndicatorReasonMap };
  const review = vi.fn();
  const reveal = vi.fn();
  const controller = createWorkspaceSidebarIndicatorActions({
    workspace: () => current.workspace, reasons: () => current.reasons,
    enabled: () => ({ "idx.review": current.enabled }), beforeOpen: vi.fn(), reveal,
    handlers: { "idx.review": review },
  });
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 1, clientY: 1 } as unknown as MouseEvent;
  return { current, controller, review, reveal, event };
}
afterEach(() => vi.unstubAllGlobals());

describe("workspace indicator action activation", () => {
  it("invokes the existing AI review callback without revealing or collapsing a panel", () => {
    const f = fixture();
    f.controller.open(f.event, "idx");
    f.controller.run("idx.review");
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.reveal).not.toHaveBeenCalled();
    expect(f.controller.menu.state.tab).toBeNull();
  });

  it.each(["workspace", "reason", "capability"])("rejects stale activation after %s changes", (change) => {
    const f = fixture();
    f.controller.open(f.event, "idx");
    if (change === "workspace") f.current.workspace = "/project/b";
    if (change === "reason") f.current.reasons = {};
    if (change === "capability") f.current.enabled = false;
    f.controller.run("idx.review");
    expect(f.review).not.toHaveBeenCalled();
    f.controller.reconcile();
    expect(f.controller.menu.state.tab).toBeNull();
    f.controller.menu.dispose();
  });

  it("never accepts commands unrelated to current causes", () => {
    const f = fixture();
    f.controller.open(f.event, "idx");
    f.controller.run("git.push");
    expect(f.reveal).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    f.controller.menu.dispose();
  });

  it("closes when one reason clears even while another remains", () => {
    const f = fixture();
    f.current.reasons = { idx: [
      { id: "idx.dirty", tone: "warning", reason: "Dirty knowledge" },
      { id: "idx.stale", tone: "info", reason: "Stale index" },
    ] };
    f.controller.open(f.event, "idx");
    f.current.reasons = { idx: [{ id: "idx.stale", tone: "info", reason: "Stale index" }] };
    f.controller.reconcile();
    expect(f.controller.menu.state.tab).toBeNull();
  });

  it("keeps a menu open when only reason copy changes", () => {
    const f = fixture();
    f.controller.open(f.event, "idx");
    f.current.reasons = { idx: [{ id: "idx.dirty", tone: "warning", reason: "Updated diagnostic" }] };
    f.controller.reconcile();
    expect(f.controller.menu.state.tab).toBe("idx");
    f.controller.menu.dispose();
  });

  it("routes inspection through reveal rather than toggle", () => {
    const f = fixture();
    f.current.reasons = { idx: [{ id: "idx.stale", tone: "info", reason: "Stale index" }] };
    f.controller.open(f.event, "idx");
    f.controller.run("idx.maintenance");
    expect(f.reveal).toHaveBeenCalledWith("idx");
    expect(f.controller.menu.state.tab).toBeNull();
  });
});
