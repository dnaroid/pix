import type { WorkbenchTabId } from "../lib/workbench-tabs";

type WorkbenchTerminalStateOptions = {
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  setActiveWorkbenchTabId: (id: WorkbenchTabId | null) => void;
  nextWorkbenchAuxOrder: () => number;
};

export function createWorkbenchTerminalState(options: WorkbenchTerminalStateOptions) {
  let open = $state(false);
  let insertAfterId = $state<WorkbenchTabId | null>(null);
  let openedOrder = $state(0);

  function show(): void {
    if (!open) {
      insertAfterId = options.activeWorkbenchTabId();
      openedOrder = options.nextWorkbenchAuxOrder();
      open = true;
    }
    options.setActiveWorkbenchTabId("terminal");
  }

  function close(): void {
    open = false;
    insertAfterId = null;
    openedOrder = 0;
  }

  return {
    get open() { return open; },
    get insertAfterId() { return insertAfterId; },
    get openedOrder() { return openedOrder; },
    show,
    close,
    reset: close,
  };
}

export type WorkbenchTerminalState = ReturnType<typeof createWorkbenchTerminalState>;
