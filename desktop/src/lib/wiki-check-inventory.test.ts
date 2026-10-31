import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, report } = vi.hoisted(() => ({ invoke: vi.fn(), report: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./diagnostic-logging", () => ({ createDiagnosticLogger: () => ({ warn: report }) }));

import { listWikiCheckDirectory, readWikiCheckDocument, releaseWikiCheckInventory } from "./wiki-check-inventory";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const request = { workspace: "/project", wikiPath: "docs/wiki", path: "docs/wiki" };
beforeEach(() => { invoke.mockReset(); report.mockClear(); });

describe("Wiki background inventory bridge", () => {
  it("passes the configured root and retains an empty page's continuation", async () => {
    const page = { entries: [], nextCursor: "next" };
    invoke.mockResolvedValue(page);
    expect(await listWikiCheckDirectory(request, new AbortController().signal)).toBe(page);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("list_wiki_check_directory", request);
  });

  it("releases a late returned cursor instead of delivering an aborted page", async () => {
    const native = deferred<{ entries: []; nextCursor: string }>();
    invoke.mockImplementation((command: string) => command === "list_wiki_check_directory" ? native.promise : Promise.resolve());
    const abort = new AbortController();
    const pending = listWikiCheckDirectory({ ...request, cursor: "old" }, abort.signal);
    const reason = new Error("Project changed");
    const rejected = expect(pending).rejects.toBe(reason);
    abort.abort(reason);
    native.resolve({ entries: [], nextCursor: "new" });
    await rejected;
    expect(invoke).toHaveBeenLastCalledWith("release_wiki_check_inventory", { workspace: "/project", cursor: "new" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("releases an unconsumed input cursor when native validation fails", async () => {
    const cause = new Error("Directory changed");
    invoke.mockImplementation((command: string) => command === "list_wiki_check_directory" ? Promise.reject(cause) : Promise.resolve());
    await expect(listWikiCheckDirectory({ ...request, cursor: "old" }, new AbortController().signal)).rejects.toBe(cause);
    expect(invoke).toHaveBeenLastCalledWith("release_wiki_check_inventory", { workspace: "/project", cursor: "old" });
  });

  it("releases an owned cursor without listing when already aborted", async () => {
    invoke.mockResolvedValue(undefined);
    const abort = new AbortController();
    abort.abort(new Error("Stopped"));
    await expect(listWikiCheckDirectory({ ...request, cursor: "old" }, abort.signal)).rejects.toBe(abort.signal.reason);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("release_wiki_check_inventory", { workspace: "/project", cursor: "old" });
  });

  it("does not call native listing for an aborted fresh request", async () => {
    const abort = new AbortController();
    abort.abort(new Error("Stopped"));
    await expect(listWikiCheckDirectory(request, abort.signal)).rejects.toBe(abort.signal.reason);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("logs cleanup failure while preserving the original cancellation", async () => {
    const native = deferred<{ entries: []; nextCursor: string }>();
    const cleanupError = new Error("Cleanup unavailable");
    invoke.mockImplementation((command: string) => command === "list_wiki_check_directory" ? native.promise : Promise.reject(cleanupError));
    const abort = new AbortController();
    const pending = listWikiCheckDirectory(request, abort.signal);
    const reason = new Error("Stopped");
    const rejected = expect(pending).rejects.toBe(reason);
    abort.abort(reason);
    native.resolve({ entries: [], nextCursor: "new" });
    await rejected;
    expect(report).toHaveBeenCalledExactlyOnceWith("wiki:inventory-release-failed", cleanupError);
  });

  it("exposes explicit workspace-owned cursor release", async () => {
    invoke.mockResolvedValue(undefined);
    await releaseWikiCheckInventory("/original-project", "owned");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("release_wiki_check_inventory", { workspace: "/original-project", cursor: "owned" });
  });
});

describe("Wiki background document reader", () => {
  it("requests the guarded native reader and returns its exact saved bytes", async () => {
    const document = { path: "docs/wiki/rules.md", content: "<!-- pix:wiki-report {} -->\n# Rules\r\n" };
    invoke.mockResolvedValue(document);
    expect(await readWikiCheckDocument("/project", "docs/wiki", document.path, new AbortController().signal)).toBe(document);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("read_wiki_check_document", {
      workspace: "/project", wikiPath: "docs/wiki", path: document.path,
    });
  });

  it("never delivers file bytes after the requesting owner was aborted", async () => {
    const native = deferred<{ path: string; content: string }>();
    invoke.mockReturnValue(native.promise);
    const abort = new AbortController();
    const pending = readWikiCheckDocument("/project", "docs/wiki", "docs/wiki/rules.md", abort.signal);
    const reason = new Error("Project changed");
    const rejected = expect(pending).rejects.toBe(reason);
    abort.abort(reason);
    native.resolve({ path: "docs/wiki/rules.md", content: "late bytes" });
    await rejected;
  });

  it("does not dispatch an already aborted read", async () => {
    const abort = new AbortController();
    abort.abort(new Error("Stopped"));
    await expect(readWikiCheckDocument("/project", "docs/wiki", "docs/wiki/rules.md", abort.signal)).rejects.toBe(abort.signal.reason);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a reply for another document", async () => {
    invoke.mockResolvedValue({ path: "other.md", content: "other" });
    await expect(readWikiCheckDocument("/project", "docs/wiki", "docs/wiki/rules.md", new AbortController().signal))
      .rejects.toThrow("another document");
  });
});
