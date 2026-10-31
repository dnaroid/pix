import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, report } = vi.hoisted(() => ({ invoke: vi.fn(), report: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./diagnostic-logging", () => ({ createDiagnosticLogger: () => ({ report }) }));

import { listWikiStatusDirectory, readWikiStatusDocument } from "./wiki-check-inventory";

const request = { workspace: "/project", wikiPath: "wiki", path: "wiki/notes" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { invoke.mockReset(); report.mockClear(); });

describe("Wiki status-only inventory bridge", () => {
  it("uses the status-only command and retains a filtered page cursor", async () => {
    const page = { entries: [], nextCursor: "next-status-page" };
    invoke.mockResolvedValue(page);
    expect(await listWikiStatusDirectory(request, new AbortController().signal)).toBe(page);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("list_wiki_status_directory", request);
  });

  it("releases late status cursors after cancellation", async () => {
    const native = deferred<{ entries: []; nextCursor: string }>();
    invoke.mockImplementation((command: string) => command === "list_wiki_status_directory" ? native.promise : Promise.resolve());
    const controller = new AbortController();
    const pending = listWikiStatusDirectory({ ...request, cursor: "old" }, controller.signal);
    const reason = new Error("Wiki replaced");
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    native.resolve({ entries: [], nextCursor: "late" });
    await rejected;
    expect(invoke).toHaveBeenLastCalledWith("release_wiki_check_inventory", { workspace: "/project", cursor: "late" });
  });

  it("releases an unconsumed cursor when the native scope or mode rejects it", async () => {
    const reason = new Error("Cursor belongs to another inventory mode");
    invoke.mockImplementation((command: string) => command === "list_wiki_status_directory" ? Promise.reject(reason) : Promise.resolve());
    await expect(listWikiStatusDirectory({ ...request, cursor: "old" }, new AbortController().signal)).rejects.toBe(reason);
    expect(invoke).toHaveBeenLastCalledWith("release_wiki_check_inventory", { workspace: "/project", cursor: "old" });
  });

  it("avoids native reads after owner cancellation and still releases an owned cursor", async () => {
    invoke.mockResolvedValue(undefined);
    const controller = new AbortController();
    controller.abort(new Error("Disposed"));
    await expect(listWikiStatusDirectory({ ...request, cursor: "old" }, controller.signal)).rejects.toBe(controller.signal.reason);
    await expect(readWikiStatusDocument("/project", "wiki", "wiki/notes/rules.md", controller.signal)).rejects.toBe(controller.signal.reason);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("release_wiki_check_inventory", { workspace: "/project", cursor: "old" });
  });

  it("reads visible generated Markdown through the separate guarded status command", async () => {
    const file = { path: "wiki/node_modules/notes.md", content: "<!-- pix:wiki-report {} -->\n# Saved\r\n" };
    invoke.mockResolvedValue(file);
    expect(await readWikiStatusDocument("/project", "wiki", file.path, new AbortController().signal)).toBe(file);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("read_wiki_status_document", { workspace: "/project", wikiPath: "wiki", path: file.path });
  });

  it("rejects late bytes and replies naming another file", async () => {
    const native = deferred<{ path: string; content: string }>();
    invoke.mockReturnValueOnce(native.promise);
    const controller = new AbortController();
    const pending = readWikiStatusDocument("/project", "wiki", "wiki/draft.md", controller.signal);
    const rejected = expect(pending).rejects.toThrow("Changed project");
    controller.abort(new Error("Changed project"));
    native.resolve({ path: "wiki/draft.md", content: "old owner" });
    await rejected;
    invoke.mockResolvedValue({ path: "wiki/another.md", content: "wrong reply" });
    await expect(readWikiStatusDocument("/project", "wiki", "wiki/draft.md", new AbortController().signal)).rejects.toThrow("another document");
  });
});
