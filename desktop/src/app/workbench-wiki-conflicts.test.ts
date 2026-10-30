import { describe, expect, it, vi } from "vitest";
import type { WorkbenchTabId } from "../lib/workbench-tabs";
import { createWorkbenchWikiConflictsState } from "./workbench-wiki-conflicts.svelte";

describe("workbench Wiki Conflicts state", () => {
  it("anchors on first open, focuses the same tab on reopen, and resets cleanly", () => {
    let active: WorkbenchTabId | null = "preview";
    let order = 4;
    const select = vi.fn((id: WorkbenchTabId | null) => { active = id; });
    const conflicts = createWorkbenchWikiConflictsState({
      activeWorkbenchTabId: () => active,
      setActiveWorkbenchTabId: select,
      nextWorkbenchAuxOrder: () => ++order,
    });

    conflicts.show();
    expect(conflicts).toMatchObject({ open: true, insertAfterId: "preview", openedOrder: 5 });
    expect(active).toBe("wiki-conflicts");

    active = "terminal";
    conflicts.show();
    expect(conflicts).toMatchObject({ insertAfterId: "preview", openedOrder: 5 });
    expect(active).toBe("wiki-conflicts");
    expect(order).toBe(5);

    conflicts.reset();
    expect(conflicts).toMatchObject({ open: false, insertAfterId: null, openedOrder: 0 });
  });

  it("applies entry requests to the shared inbox and reveals the sidebar list", () => {
    let active: WorkbenchTabId | null = "preview";
    const revealList = vi.fn();
    const conflicts = createWorkbenchWikiConflictsState({
      activeWorkbenchTabId: () => active,
      setActiveWorkbenchTabId: (id) => { active = id; },
      nextWorkbenchAuxOrder: () => 1,
      snapshot: () => ({ findings: [], truncated: false, complete: true }),
      revealList,
    });
    expect(conflicts.sidebarView).toBe("pages");
    conflicts.show({ path: "wiki/a.md" });
    expect(conflicts.inbox.branch).toBe("wiki/a.md");
    expect(conflicts.sidebarView).toBe("conflicts");
    expect(revealList).toHaveBeenCalledTimes(1);
    expect(active).toBe("wiki-conflicts");

    // A bare open keeps the current branch; selecting from the list only reveals the tab.
    conflicts.show();
    expect(conflicts.inbox.branch).toBe("wiki/a.md");
    active = "preview";
    conflicts.reveal();
    expect(active).toBe("wiki-conflicts");
    expect(revealList).toHaveBeenCalledTimes(2);

    conflicts.show({ findingId: "f" });
    expect(conflicts.inbox).toMatchObject({ branch: "", status: "all" });

    conflicts.close();
    expect(conflicts.inbox.status).toBe("all");
    conflicts.reset();
    expect(conflicts.inbox).toMatchObject({ branch: "", status: "open" });
    expect(conflicts.sidebarView).toBe("pages");
  });

  it("never anchors to itself", () => {
    let active: WorkbenchTabId | null = "wiki-conflicts";
    const conflicts = createWorkbenchWikiConflictsState({
      activeWorkbenchTabId: () => active,
      setActiveWorkbenchTabId: (id) => { active = id; },
      nextWorkbenchAuxOrder: () => 1,
    });
    conflicts.show();
    expect(conflicts.insertAfterId).toBeNull();
  });
});
