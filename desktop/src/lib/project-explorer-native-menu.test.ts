import { beforeEach, describe, expect, it, vi } from "vitest";
import { Menu } from "@tauri-apps/api/menu";
import { canOpenProjectEntryInBrowser, createProjectExplorerNativeMenu, projectExplorerMenuActions, type ProjectExplorerMenuAction } from "./project-explorer-native-menu";
import type { ProjectTreeEntry } from "./project-tree";

vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: vi.fn() } }));

const entry: ProjectTreeEntry = { name: "src", path: "src", kind: "directory" };
const position = { x: 790, y: 590 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function menu() { return { popup: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }; }
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function fixture(prepare = vi.fn().mockResolvedValue(undefined)) {
  const action = vi.fn();
  const reportError = vi.fn();
  const items = vi.fn((): ProjectExplorerMenuAction[] => [
    { id: "open", label: "Open", action },
    { id: "paste", label: "Paste", disabled: true, separatorBefore: true, action },
  ]);
  const controller = createProjectExplorerNativeMenu({ prepare, items, reportError });
  return { controller, prepare, items, action, reportError };
}
function commands(call = 0) {
  return vi.mocked(Menu.new).mock.calls[call]![0]!.items as { id?: string; text?: string; enabled?: boolean; item?: string; action?: () => void }[];
}

beforeEach(() => vi.resetAllMocks());

describe("native Project Explorer context menu", () => {
  it("offers browser opening only for HTML files, case-insensitively", () => {
    for (const path of ["page.html", "nested/page.HTM", "page.HTML"]) {
      expect(canOpenProjectEntryInBrowser({ name: path, path, kind: "file" })).toBe(true);
    }
    for (const path of ["", "page.txt", "page.html.txt"]) {
      expect(canOpenProjectEntryInBrowser({ name: path, path, kind: "file" })).toBe(false);
    }
    expect(canOpenProjectEntryInBrowser({ name: "folder.html", path: "folder.html", kind: "directory" })).toBe(false);
  });
  it("keeps browser and external editor callback ids distinct", () => {
    const browser = vi.fn();
    const editor = vi.fn();
    const actions = projectExplorerMenuActions(
      [{ label: "Open in Browser" }, { label: "Open in Editor" }],
      { "Open in Browser": browser, "Open in Editor": editor }, "Reveal in Finder", false,
    );
    expect(actions.map(({ id }) => id)).toEqual(["browser", "external"]);
    actions[0]!.action();
    expect(browser).toHaveBeenCalledOnce();
    expect(editor).not.toHaveBeenCalled();
  });
  it("preserves shared command policy, groups and stable ids for dynamic labels", () => {
    const action = vi.fn();
    const result = projectExplorerMenuActions([
      { label: "Open in Editor" }, { label: "Show in Finder" },
      { label: "Paste", disabled: true },
    ], { "Open in Editor": action, "Show in Finder": action, Paste: action }, "Show in Finder", true);
    expect(result.map((item) => item.id)).toEqual(["external", "reveal", "Paste"]);
    expect(result[2]).toMatchObject({ disabled: true, separatorBefore: true, action });
    expect(() => projectExplorerMenuActions([{ label: "Unknown" }], {}, "Show in Finder", false)).toThrow("Unknown Project Explorer command");
  });
  it("waits for eligibility and delegates exact coordinates and disabled commands to the OS", async () => {
    const preparation = deferred<void>();
    const f = fixture(vi.fn(() => preparation.promise));
    const native = menu();
    vi.mocked(Menu.new).mockResolvedValue(native as unknown as Menu);
    const showing = f.controller.show(entry, position, () => true);
    expect(Menu.new).not.toHaveBeenCalled();
    preparation.resolve();
    await showing;
    expect(f.items).toHaveBeenCalledExactlyOnceWith(entry);
    expect(commands().map((item) => item.text ?? item.item)).toEqual(["Open", "Separator", "Paste"]);
    expect(commands()[2]!.enabled).toBe(false);
    expect(native.popup).toHaveBeenCalledWith(expect.objectContaining(position));
    commands()[0]!.action!();
    commands()[2]!.action!();
    await flush();
    expect(f.action).toHaveBeenCalledOnce();
    // The resolved popup does not destroy a menu or its active callbacks.
    expect(native.close).not.toHaveBeenCalled();
    f.controller.dispose();
    expect(native.close).toHaveBeenCalledOnce();
  });

  it("cancels preparation on replacement and teardown", async () => {
    for (const cancel of ["close", "dispose"] as const) {
      const preparation = deferred<void>();
      const f = fixture(vi.fn(() => preparation.promise));
      const showing = f.controller.show(entry, position, () => true);
      f.controller[cancel]();
      preparation.resolve();
      await showing;
      expect(Menu.new).not.toHaveBeenCalled();
      expect(f.items).not.toHaveBeenCalled();
    }
  });

  it("releases late creations without presenting them after detach or disposal", async () => {
    for (const invalidate of ["detach", "dispose"] as const) {
      const creation = deferred<Menu>();
      const native = menu();
      vi.mocked(Menu.new).mockReturnValueOnce(creation.promise);
      const f = fixture();
      let connected = true;
      const showing = f.controller.show(entry, position, () => connected);
      await flush();
      if (invalidate === "dispose") f.controller.dispose();
      else connected = false;
      creation.resolve(native as unknown as Menu);
      await showing;
      expect(native.popup).not.toHaveBeenCalled();
      expect(native.close).toHaveBeenCalledOnce();
    }
  });

  it("serializes native registrations and only presents the newest target", async () => {
    const creation = deferred<Menu>();
    const old = menu(), next = menu();
    vi.mocked(Menu.new).mockReturnValueOnce(creation.promise).mockResolvedValueOnce(next as unknown as Menu);
    const f = fixture();
    const first = f.controller.show(entry, position, () => true);
    await flush();
    const second = f.controller.show({ ...entry, path: "other" }, { x: 1, y: 2 }, () => true);
    await flush();
    expect(Menu.new).toHaveBeenCalledOnce();
    creation.resolve(old as unknown as Menu);
    await Promise.all([first, second]);
    expect(old.popup).not.toHaveBeenCalled();
    expect(old.close).toHaveBeenCalledOnce();
    expect(next.popup).toHaveBeenCalledWith(expect.objectContaining({ x: 1, y: 2 }));
    commands(0)[0]!.action!();
    commands(1)[0]!.action!();
    await flush();
    expect(f.action).toHaveBeenCalledOnce();
    f.controller.dispose();
  });

  it("namespaces stable command ids between mounted owners", async () => {
    vi.mocked(Menu.new).mockImplementation(async () => menu() as unknown as Menu);
    const first = fixture(), second = fixture();
    await first.controller.show(entry, position, () => true);
    await first.controller.show(entry, position, () => true);
    await second.controller.show(entry, position, () => true);
    expect(commands(0)[0]!.id).toEqual(commands(1)[0]!.id);
    expect(commands(0)[0]!.id).not.toEqual(commands(2)[0]!.id);
    first.controller.dispose(); second.controller.dispose();
  });

  it("invalidates queued actions when the target is replaced before dispatch", async () => {
    vi.mocked(Menu.new).mockResolvedValue(menu() as unknown as Menu);
    const f = fixture();
    await f.controller.show(entry, position, () => true);
    commands()[0]!.action!();
    f.controller.close();
    await flush();
    expect(f.action).not.toHaveBeenCalled();
  });

  it("reports creation, preparation and action failures", async () => {
    const error = new Error("native failed");
    const f = fixture();
    vi.mocked(Menu.new).mockRejectedValueOnce(error);
    await f.controller.show(entry, position, () => true);
    expect(f.reportError).toHaveBeenCalledWith(error);
    f.prepare.mockRejectedValueOnce(error);
    await f.controller.show(entry, position, () => true);
    expect(f.reportError).toHaveBeenCalledTimes(2);
    vi.mocked(Menu.new).mockResolvedValue(menu() as unknown as Menu);
    f.action.mockImplementationOnce(() => { throw error; });
    await f.controller.show(entry, position, () => true);
    commands(1)[0]!.action!();
    await flush();
    expect(f.reportError).toHaveBeenCalledTimes(3);
    f.controller.dispose();
  });

  it("releases a rejected popup exactly once even if replacement already released it", async () => {
    const popup = deferred<void>();
    const native = menu();
    native.popup.mockReturnValueOnce(popup.promise);
    vi.mocked(Menu.new).mockResolvedValue(native as unknown as Menu);
    const f = fixture();
    const showing = f.controller.show(entry, position, () => true);
    await flush();
    f.controller.close();
    popup.reject(new Error("late popup failure"));
    await showing;
    expect(native.close).toHaveBeenCalledOnce();
    expect(f.reportError).not.toHaveBeenCalled();
  });
});
