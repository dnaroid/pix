import { describe, expect, it, vi } from "vitest";
import type { WorkbenchTabId } from "../lib/workbench-tabs";
import { createWorkbenchTerminalState } from "./workbench-terminal.svelte";

describe("workbench terminal state", () => {
  it("anchors on first open, reuses the tab while open, and resets cleanly", () => {
    let active: WorkbenchTabId | null = "session:a";
    let order = 0;
    const select = vi.fn((id: typeof active) => { active = id; });
    const terminal = createWorkbenchTerminalState({
      activeWorkbenchTabId: () => active,
      setActiveWorkbenchTabId: select,
      nextWorkbenchAuxOrder: () => ++order,
    });

    terminal.show();
    expect(terminal.open).toBe(true);
    expect(terminal.insertAfterId).toBe("session:a");
    expect(terminal.openedOrder).toBe(1);
    expect(active).toBe("terminal");

    active = "preview";
    terminal.show();
    expect(terminal.insertAfterId).toBe("session:a");
    expect(terminal.openedOrder).toBe(1);
    expect(active).toBe("terminal");

    terminal.close();
    expect(terminal.open).toBe(false);
    expect(terminal.insertAfterId).toBeNull();
    expect(terminal.openedOrder).toBe(0);
  });
});
