import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceSidebarIndicatorActions } from "./workspace-sidebar-indicator-actions";
import type { SidebarIndicatorActionGroup } from "../lib/sidebar-indicator-actions";

class Element {
  isConnected = true;
  focus = vi.fn();
  getBoundingClientRect = () => ({ right: 30, top: 10 });
}

function fixture() {
  const trigger = new Element();
  vi.stubGlobal("HTMLElement", Element);
  vi.stubGlobal("document", { activeElement: trigger });
  let workspace = "/one";
  let groups: readonly SidebarIndicatorActionGroup[] = [{ id: "scripts.commands", reason: "Launch commands", actions: [
    { id: "scripts.command.launch:dev", label: "Run Dev" },
  ] }];
  const runExtra = vi.fn(() => true);
  const reveal = vi.fn();
  const actions = createWorkspaceSidebarIndicatorActions({
    workspace: () => workspace, reasons: () => ({}), enabled: () => ({}),
    extraGroups: (tab) => tab === "scripts" ? groups : [], runExtra, reveal,
    beforeOpen: () => {}, handlers: {},
  });
  const event = { clientX: 10, clientY: 10, currentTarget: trigger, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent;
  return { actions, event, runExtra, reveal, trigger,
    setWorkspace: (value: string) => { workspace = value; },
    setGroups: (value: readonly SidebarIndicatorActionGroup[]) => { groups = value; },
  };
}

afterEach(() => vi.unstubAllGlobals());

it("opens launch actions without an indicator and executes without revealing the panel", () => {
  const f = fixture();
  f.actions.open(f.event, "scripts");
  expect(f.actions.menu.state.tab).toBe("scripts");
  f.actions.run("scripts.command.launch:dev");
  expect(f.runExtra).toHaveBeenCalledWith("scripts.command.launch:dev");
  expect(f.reveal).not.toHaveBeenCalled();
  expect(f.actions.menu.state.tab).toBeNull();
  expect(f.trigger.focus).toHaveBeenCalled();
});

it("does not expose launch actions on unrelated healthy tabs", () => {
  const f = fixture();
  f.actions.open(f.event, "project");
  expect(f.actions.menu.state.tab).toBeNull();
});

it("rejects old workspace callbacks even before reconciliation", () => {
  const f = fixture();
  f.actions.open(f.event, "scripts");
  f.setWorkspace("/two");
  f.actions.run("scripts.command.launch:dev");
  expect(f.runExtra).not.toHaveBeenCalled();
  f.actions.reconcile();
  expect(f.actions.menu.state.tab).toBeNull();
});

it.each(["stopped", "disabled", "renamed"])("closes safely when a menu command is %s", (change) => {
  const f = fixture();
  f.actions.open(f.event, "scripts");
  f.setGroups([{ id: "scripts.commands", reason: "Launch commands", actions: [{
    id: change === "stopped" ? "scripts.command.stop:pty" : "scripts.command.launch:dev",
    label: change === "renamed" ? "Run New name" : "Run Dev", disabled: change === "disabled",
  }] }]);
  if (change !== "renamed") {
    f.actions.run("scripts.command.launch:dev");
    expect(f.runExtra).not.toHaveBeenCalled();
  }
  f.actions.reconcile();
  expect(f.actions.menu.state.tab).toBeNull();
  expect(f.trigger.focus).toHaveBeenCalled();
});
