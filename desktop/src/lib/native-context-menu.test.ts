import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createNativeContextMenuFactory, nativeContextMenuItems } from "./native-context-menu";
import type { DesktopContextTarget } from "./desktop-context-target";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: vi.fn() } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

function context(overrides: Partial<DesktopContextTarget> = {}): DesktopContextTarget {
  return {
    kind: "editable", element: { isConnected: true } as HTMLElement,
    editor: null, hasSelection: true, readOnly: false, ...overrides,
  };
}
const reportError = vi.fn();
const items = (value: Partial<DesktopContextTarget>, linux = false, active = () => true) =>
  nativeContextMenuItems(context(value), linux, reportError, active);
const labels = (value: Partial<DesktopContextTarget>) => items(value).map((item) => "item" in item ? item.item : "text" in item ? item.text : "");

describe("native desktop context menu commands", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses native editing roles instead of replacing values or synthesizing paste", () => {
    expect(labels({})).toEqual(["Undo", "Redo", "Separator", "Cut", "Copy", "Paste", "Separator", "SelectAll"]);
  });
  it("limits read-only and selected document text to applicable commands", () => {
    expect(labels({ kind: "readonly", readOnly: true })).toEqual(["Copy", "Separator", "SelectAll"]);
    expect(labels({ kind: "selection", readOnly: true })).toEqual(["Copy"]);
  });
  it("never offers copying or cutting a password", () => {
    expect(labels({ kind: "password" })).toEqual(["Undo", "Redo", "Separator", "Paste", "Separator", "SelectAll"]);
    expect(labels({ kind: "password", readOnly: true })).toEqual(["SelectAll"]);
  });
  it("does not offer text-editor undo or paste into a stopped terminal", () => {
    expect(labels({ kind: "terminal" })).toEqual(["Copy", "Paste"]);
    expect(labels({ kind: "terminal", readOnly: true })).toEqual(["Copy"]);
  });
  it("offers both selection copy and link actions, without browser navigation or developer actions", () => {
    expect(labels({ kind: "selection", linkUrl: "https://example.com/" })).toEqual(["Copy", "Separator", "Open Link", "Copy Link Address"]);
    expect(labels({ kind: "link", hasSelection: false, linkUrl: "https://example.com/" })).toEqual(["Open Link", "Copy Link Address"]);
  });
  it("copies the captured link via the native clipboard and opens only on command activation", async () => {
    const commands = items({ kind: "link", hasSelection: false, linkUrl: "https://example.com/a" });
    expect(openUrl).not.toHaveBeenCalled();
    for (const item of commands) if ("action" in item) item.action?.("ignored");
    await Promise.resolve();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a");
    expect(writeText).toHaveBeenCalledWith("https://example.com/a");
  });
  it("ignores stale native callbacks and detached targets", () => {
    for (const commands of [
      items({ linkUrl: "https://example.com/" }, false, () => false),
      items({ linkUrl: "https://example.com/", element: { isConnected: false } as HTMLElement }),
    ]) for (const item of commands) if ("action" in item) item.action?.("ignored");
    expect(openUrl).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
  it("reports native clipboard failures instead of unhandled promise rejections", async () => {
    vi.mocked(writeText).mockRejectedValueOnce(new Error("clipboard unavailable"));
    const command = items({ linkUrl: "https://example.com/" }).find((item) => "id" in item && item.id === "desktop.link.copy");
    if (command && "action" in command) command.action?.("ignored");
    await Promise.resolve();
    await Promise.resolve();
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "clipboard unavailable" }));
  });
  it("uses the closed WebKit editing command bridge on Linux instead of X11 key emulation", () => {
    const commands = items({}, true);
    for (const item of commands) if ("action" in item) item.action?.("ignored");
    expect(vi.mocked(invoke).mock.calls).toEqual(
      ["Undo", "Redo", "Cut", "Copy", "Paste", "SelectAll"].map((command) => ["desktop_edit", { command }]),
    );
  });
  it("disables Linux cut/copy when an editable field has no selection", () => {
    const commands = items({ hasSelection: false }, true);
    expect(commands.filter((item) => "enabled" in item && item.enabled === false)
      .map((item) => "id" in item && item.id)).toEqual(["desktop.text.Cut", "desktop.text.Copy"]);
  });
});

describe("native menu registration ownership", () => {
  beforeEach(() => {
    vi.mocked(Menu.new).mockReset();
    vi.mocked(Menu.new).mockResolvedValue({ popup: vi.fn(), close: vi.fn() } as unknown as Menu);
  });

  function commandIds(call: number) {
    return vi.mocked(Menu.new).mock.calls[call]?.[0]?.items
      ?.flatMap((item) => "id" in item ? [item.id] : []);
  }

  it("keeps callback ids bounded per owner and isolated between windows/mounts", async () => {
    const first = createNativeContextMenuFactory(reportError);
    const second = createNativeContextMenuFactory(reportError);
    const target = context({ kind: "link", hasSelection: false, linkUrl: "https://example.com/" });
    await first(target, () => true);
    await first(target, () => true);
    await second(target, () => true);
    expect(commandIds(0)).toHaveLength(2);
    expect(commandIds(1)).toEqual(commandIds(0));
    expect(commandIds(2)).not.toEqual(commandIds(0));
  });

  it("serializes native registration so old IPC cannot replace newer callbacks", async () => {
    let release!: (menu: Menu) => void;
    vi.mocked(Menu.new).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const create = createNativeContextMenuFactory(reportError);
    const first = create(context(), () => true);
    const second = create(context(), () => true);
    await Promise.resolve();
    expect(Menu.new).toHaveBeenCalledOnce();
    release({ popup: vi.fn(), close: vi.fn() } as unknown as Menu);
    await Promise.all([first, second]);
    expect(Menu.new).toHaveBeenCalledTimes(2);
  });

  it("allows the next menu to open after a registration failure", async () => {
    vi.mocked(Menu.new).mockRejectedValueOnce(new Error("denied"));
    const create = createNativeContextMenuFactory(reportError);
    await expect(create(context(), () => true)).rejects.toThrow("denied");
    await expect(create(context(), () => true)).resolves.toHaveProperty("popup");
  });
});
