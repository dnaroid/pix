import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createNativeContextMenuFactory, nativeContextMenuItems } from "./native-context-menu";
import type { DesktopContextTarget } from "./desktop-context-target";
import { copyContextImage, openContextImage } from "./image-context-actions";

vi.mock("./image-context-actions", () => ({ copyContextImage: vi.fn().mockResolvedValue(undefined), openContextImage: vi.fn().mockResolvedValue(undefined) }));

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
  it("offers source reference copy without requiring a text selection", () => {
    expect(labels({ kind: "readonly", hasSelection: false, sourceReference: "src/main.ts:42" }))
      .toEqual(["Copy Relative Path with Line Number"]);
    expect(labels({ kind: "selection", hasSelection: true, sourceReference: "src/main.ts:42" }))
      .toEqual(["Copy", "Separator", "Copy Relative Path with Line Number"]);
  });
  it("copies the captured source reference and ignores stale or detached callbacks", async () => {
    for (const [active, connected] of [[true, true], [false, true], [true, false]]) {
      const commands = items({ kind: "readonly", hasSelection: false, sourceReference: "src/my file.ts:42",
        element: { isConnected: connected } as HTMLElement }, false, () => active!);
      const command = commands.find((item) => "id" in item && item.id === "desktop.source.reference");
      if (command && "action" in command) command.action?.("ignored");
    }
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("src/my file.ts:42");
  });
  it("prioritizes image commands over the surrounding link and selection", async () => {
    const image = {} as HTMLImageElement;
    const commands = items({ kind: "image", image, linkUrl: "https://example.com/" });
    expect(commands.map((item) => "text" in item && item.text)).toEqual(["Open Image in External App", "Copy Image", "Reveal in Finder", false, "Copy Absolute Path", "Copy Relative Path"]);
    for (const command of commands) if ("action" in command) command.action?.("ignored");
    await Promise.resolve();
    expect(openContextImage).toHaveBeenCalledWith(image, expect.any(Function));
    expect(copyContextImage).toHaveBeenCalledWith(image, expect.any(Function));
    expect(openUrl).not.toHaveBeenCalled();
  });
  it("ignores stale image menu callbacks", () => {
    const commands = items({ kind: "image", image: {} as HTMLImageElement }, false, () => false);
    for (const command of commands) if ("action" in command) command.action?.("ignored");
    expect(openContextImage).not.toHaveBeenCalled();
    expect(copyContextImage).not.toHaveBeenCalled();
  });
  it("copies actual files, opens externally and reveals captured local paths", async () => {
    const commands = items({ kind: "file", hasSelection: false, filePath: "/project/my video.mov" });
    expect(commands.map((item) => "text" in item && item.text)).toEqual(["Copy File", "Open in External App", "Reveal in Finder"]);
    for (const command of commands) if ("action" in command) command.action?.("ignored");
    await Promise.resolve();
    expect(vi.mocked(invoke).mock.calls).toEqual(["copy", "open", "reveal"].map(action => ["preview_file_action", { path: "/project/my video.mov", action }]));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reveals a captured Preview tab path in Files only while the menu is current", async () => {
    const reveal = vi.fn(async () => {});
    for (const active of [true, false]) {
      const commands = nativeContextMenuItems(context({ kind: "file", hasSelection: false,
        filePath: "/project/a/file.ts", projectRevealPath: "a/file.ts" }), false, reportError, () => active, reveal);
      const item = commands.find((item) => "id" in item && item.id === "desktop.file.explorer");
      expect(item).toMatchObject({ text: "Show in Files" });
      if (item && "action" in item) item.action?.("ignored");
    }
    await Promise.resolve();
    expect(reveal).toHaveBeenCalledExactlyOnceWith("a/file.ts");
  });
  it("disables file actions without a local path and never runs stale or detached actions", () => {
    const unavailable = items({ kind: "file", hasSelection: false });
    expect(unavailable).toHaveLength(3);
    expect(unavailable.every(item => "enabled" in item && item.enabled === false)).toBe(true);
    for (const commands of [unavailable,
      items({ kind: "file", filePath: "/tmp/a" }, false, () => false),
      items({ kind: "file", filePath: "/tmp/a", element: { isConnected: false } as HTMLElement }),
    ]) for (const command of commands) if ("action" in command) command.action?.("ignored");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("preserves selection and source-reference copy alongside file commands", () => {
    expect(labels({ kind: "selection", filePath: "/project/a.ts", sourceReference: "a.ts:2" })).toEqual([
      "Copy", "Separator", "Copy Relative Path with Line Number", "Separator", "Copy File", "Open in External App", "Reveal in Finder",
    ]);
  });
  it("reveals local images but disables reveal for remote/data images", async () => {
    for (const imagePath of [undefined, "/project/image.png"]) {
      const command = items({ kind: "image", image: {} as HTMLImageElement, imagePath })
        .find(item => "id" in item && item.id === "desktop.image.reveal");
      expect(command && "enabled" in command && command.enabled).toBe(Boolean(imagePath));
      if (command && "action" in command) command.action?.("ignored");
    }
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("preview_file_action", { path: "/project/image.png", action: "reveal" });
  });
  it("reports file action failures", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("missing file"));
    const command = items({ kind: "file", hasSelection: false, filePath: "/tmp/gone" })[0];
    if (command && "action" in command) command.action?.("ignored");
    await Promise.resolve();
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "missing file" }));
  });
  it("copies captured absolute and project-relative image paths", async () => {
    const commands = items({ kind: "image", image: {} as HTMLImageElement, imagePath: "/project/assets/chart.png", imageRelativePath: "assets/chart.png" });
    for (const command of commands) if ("id" in command && ["desktop.image.absolute", "desktop.image.relative"].includes(command.id ?? "") && "action" in command) command.action?.("ignored");
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("/project/assets/chart.png");
    expect(writeText).toHaveBeenCalledWith("assets/chart.png");
  });
  it("copies textarea selections through the native clipboard instead of relying on a WebView menu role", async () => {
    const editor = {
      value: "copy this text",
      selectionStart: 0,
      selectionEnd: 4,
    } as HTMLTextAreaElement;
    const commands = items({ editor, hasSelection: true });
    const copy = commands.find((item) => "id" in item && item.id === "desktop.text.Copy");
    expect(copy).toBeDefined();
    if (copy && "action" in copy) copy.action?.("ignored");
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("copy");
  });
  it("keeps contenteditable copy on the native role without assuming input selection APIs", () => {
    const commands = items({
      kind: "editable",
      editor: {} as HTMLElement,
      hasSelection: true,
    });
    expect(commands.some((item) => "item" in item && item.item === "Copy")).toBe(true);
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
