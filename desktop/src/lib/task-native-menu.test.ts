import { beforeEach, describe, expect, it, vi } from "vitest";
import { Menu } from "@tauri-apps/api/menu";
import { createTaskNativeMenu } from "./task-native-menu";
import type { ProjectTask } from "./project-tasks";

vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: vi.fn() } }));

const task: ProjectTask = {
  id: "task", title: "Task", type: "feature", status: "todo", priority: "high",
  createdAt: "2026-09-13T12:00:00.000Z", updatedAt: "2026-09-13T12:00:00.000Z",
};
const position = { x: 40, y: 120 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function nativeMenu() { return { popup: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }; }
function fixture() {
  const actions = {
    setStatus: vi.fn(), setPriority: vi.fn(), requestDelete: vi.fn(),
    createPlan: vi.fn(), openPlan: vi.fn(), canCreatePlan: vi.fn(() => true),
  };
  const reportError = vi.fn();
  return { actions, reportError, controller: createTaskNativeMenu(actions, reportError) };
}
function items(call = 0) {
  return vi.mocked(Menu.new).mock.calls[call]![0]!.items as {
    id?: string; text?: string; checked?: boolean; enabled?: boolean; item?: string; action?: () => void;
  }[];
}
function command(text: string, call = 0) { return items(call).find((item) => item.text === text)!; }
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

beforeEach(() => vi.resetAllMocks());

describe("native task menu", () => {
  it("uses native checked status/priority groups and preserves plan/delete commands", async () => {
    const f = fixture(), native = nativeMenu();
    vi.mocked(Menu.new).mockResolvedValue(native as unknown as Menu);
    await f.controller.show(task, "all", position, () => true);
    expect(native.popup).toHaveBeenCalledWith(expect.objectContaining(position));
    expect(items().map((item) => item.text ?? item.item)).toEqual([
      "Status", "Backlog", "Todo", "In progress", "Done", "Failed", "Separator",
      "Priority", "Low", "Medium", "High", "Urgent", "Separator", "Create plan", "Delete task",
    ]);
    expect(command("Status").enabled).toBe(false);
    expect(command("Priority").enabled).toBe(false);
    expect(items().filter((item) => item.checked).map((item) => item.text)).toEqual(["Todo", "High"]);
    command("Done").action!();
    command("Medium").action!();
    command("Create plan").action!();
    command("Delete task").action!();
    expect(f.actions.setStatus).toHaveBeenCalledWith(task.id, "done");
    expect(f.actions.setPriority).toHaveBeenCalledWith(task.id, "medium");
    expect(f.actions.createPlan).toHaveBeenCalledWith(task);
    expect(f.actions.requestDelete).toHaveBeenCalledWith(task.id);
    f.controller.dispose();
    expect(native.close).toHaveBeenCalledOnce();
  });

  it("keeps badge menu priority-only and opens linked plans instead of recreating them", async () => {
    const f = fixture();
    vi.mocked(Menu.new).mockImplementation(async () => nativeMenu() as unknown as Menu);
    await f.controller.show(task, "priority", position, () => true);
    expect(items().map((item) => item.text)).toEqual(["Priority", "Low", "Medium", "High", "Urgent"]);
    await f.controller.show({ ...task, links: [".pi/plans/task.md"] }, "all", position, () => true);
    command("Open plan", 1).action!();
    expect(f.actions.openPlan).toHaveBeenCalledWith(".pi/plans/task.md");
    expect(items(1).some((item) => item.text === "Create plan")).toBe(false);
    f.controller.dispose();
  });

  it("checks live plan availability and rejects callbacks after target invalidation or close", async () => {
    const f = fixture();
    vi.mocked(Menu.new).mockResolvedValue(nativeMenu() as unknown as Menu);
    let current = true;
    await f.controller.show(task, "all", position, () => current);
    f.actions.canCreatePlan.mockReturnValue(false);
    command("Create plan").action!();
    expect(f.actions.createPlan).not.toHaveBeenCalled();
    current = false;
    command("Done").action!();
    expect(f.actions.setStatus).not.toHaveBeenCalled();
    current = true;
    f.controller.close();
    command("Delete task").action!();
    expect(f.actions.requestDelete).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it.each(["dispose", "target change"])("releases late creation without showing after %s", async (reason) => {
    const f = fixture(), native = nativeMenu(), creation = deferred<Menu>();
    vi.mocked(Menu.new).mockReturnValue(creation.promise);
    let current = true;
    const showing = f.controller.show(task, "all", position, () => current);
    await flush();
    if (reason === "dispose") f.controller.dispose();
    else current = false;
    creation.resolve(native as unknown as Menu);
    await showing;
    expect(native.popup).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalledOnce();
    command("Done").action!();
    expect(f.actions.setStatus).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it("serializes replacement registration, reuses owner ids and disables stale callbacks", async () => {
    const f = fixture(), first = nativeMenu(), second = nativeMenu(), creation = deferred<Menu>();
    vi.mocked(Menu.new).mockReturnValueOnce(creation.promise).mockResolvedValueOnce(second as unknown as Menu);
    const old = f.controller.show(task, "all", position, () => true);
    await flush();
    const next = f.controller.show(task, "all", position, () => true);
    await flush();
    expect(Menu.new).toHaveBeenCalledOnce();
    creation.resolve(first as unknown as Menu);
    await Promise.all([old, next]);
    expect(first.popup).not.toHaveBeenCalled();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.popup).toHaveBeenCalledOnce();
    expect(command("Done", 1).id).toBe(command("Done").id);
    command("Done").action!();
    expect(f.actions.setStatus).not.toHaveBeenCalled();
    command("Done", 1).action!();
    expect(f.actions.setStatus).toHaveBeenCalledOnce();
    f.controller.dispose();
  });

  it("namespaces owners and logs creation/popup/action failures without unhandled rejections", async () => {
    const f = fixture(), g = fixture(), native = nativeMenu();
    const error = new Error("native failure");
    vi.mocked(Menu.new).mockRejectedValueOnce(error).mockResolvedValue(native as unknown as Menu);
    await f.controller.show(task, "all", position, () => true);
    expect(f.reportError).toHaveBeenCalledWith(error);
    await f.controller.show(task, "all", position, () => true);
    f.actions.setStatus.mockImplementation(() => { throw error; });
    command("Done", 1).action!();
    expect(f.reportError).toHaveBeenCalledTimes(2);
    await g.controller.show(task, "all", position, () => true);
    expect(command("Done", 2).id).not.toBe(command("Done", 1).id);
    native.popup.mockRejectedValueOnce(error);
    await f.controller.show(task, "all", position, () => true);
    expect(f.reportError).toHaveBeenCalledTimes(3);
    f.controller.dispose();
    g.controller.dispose();
  });
});
