import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { readSystemProjectClipboard, writeSystemProjectClipboard } from "./system-project-clipboard";
import { canPasteProjectEntry, createProjectEntryClipboardReader, decodeProjectEntryClipboard, encodeProjectEntryClipboard } from "./project-entry-clipboard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn(), writeText: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe("system Project Explorer clipboard", () => {
  const finder = JSON.stringify({ format: "pix-project-entry", version: 2, workspace: "/", operation: "copy", entries: [
    { path: "Users/test/project/docs", kind: "directory" },
    { path: "Users/test/other/a #%.txt", kind: "file" },
  ] });

  it("publishes native single and group Copy without overwriting the dual payload with text", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockResolvedValue(undefined);
    const entries = [{ name: "docs", path: "docs", kind: "directory" as const }, { name: "a #%.txt", path: "a #%.txt", kind: "file" as const }];
    await writeSystemProjectClipboard(encodeProjectEntryClipboard("/project", entries[0]!));
    expect(invoke).toHaveBeenLastCalledWith("write_project_entry_clipboard", { workspace: "/project", paths: ["docs"] });
    const text = encodeProjectEntryClipboard("/project", entries[0]!, entries);
    await writeSystemProjectClipboard(text);
    expect(invoke).toHaveBeenLastCalledWith("write_project_entry_clipboard", { workspace: "/project", paths: ["docs", "a #%.txt"] });
    vi.mocked(invoke).mockResolvedValueOnce(text);
    expect(decodeProjectEntryClipboard(await readSystemProjectClipboard())?.workspace).toBe("/project");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("keeps Cut Pix-only and preserves the browser text fallback", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(writeText).mockResolvedValue(undefined);
    const entry = { name: "a", path: "a", kind: "file" as const };
    const cut = encodeProjectEntryClipboard("/project", entry, [entry], "move");
    await writeSystemProjectClipboard(cut);
    expect(writeText).toHaveBeenLastCalledWith(cut);
    vi.mocked(isTauri).mockReturnValue(false);
    const copy = encodeProjectEntryClipboard("/project", entry);
    await writeSystemProjectClipboard(copy);
    expect(writeText).toHaveBeenLastCalledWith(copy);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not fall back to text after a native write failure or accept invalid references", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const error = new Error("write failed");
    vi.mocked(invoke).mockRejectedValue(error);
    await expect(writeSystemProjectClipboard(finder)).rejects.toBe(error);
    await expect(writeSystemProjectClipboard("/path/to/file")).rejects.toThrow("Invalid Pix");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("uses the native snapshot for Finder files and rereads on every action", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockResolvedValueOnce(finder).mockResolvedValueOnce("ordinary text");
    const copied = decodeProjectEntryClipboard(await readSystemProjectClipboard());
    expect(copied?.entries).toHaveLength(2);
    expect(copied?.operation).toBe("copy");
    expect(canPasteProjectEntry(copied, "/Users/test/project", "target")).toBe(true);
    expect(canPasteProjectEntry(copied, "/Users/test/project", "docs/sub")).toBe(false);
    expect(decodeProjectEntryClipboard(await readSystemProjectClipboard())).toBeNull();
    expect(invoke).toHaveBeenNthCalledWith(1, "read_project_entry_clipboard");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(readText).not.toHaveBeenCalled();
  });

  it("keeps the text-only browser fallback without native IPC", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    vi.mocked(readText).mockResolvedValue("text");
    expect(await readSystemProjectClipboard()).toBe("text");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("logs native read failures and clears the menu hint without a stale fallback", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const error = new Error("clipboard changed");
    vi.mocked(invoke).mockRejectedValue(error);
    const report = vi.fn();
    const publish = vi.fn();
    await createProjectEntryClipboardReader(readSystemProjectClipboard, report).refresh(publish);
    expect(report).toHaveBeenCalledWith(error);
    expect(publish).toHaveBeenCalledWith(null);
    await expect(readSystemProjectClipboard()).rejects.toBe(error);
    expect(readText).not.toHaveBeenCalled();
  });
});
