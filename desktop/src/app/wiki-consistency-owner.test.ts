import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WikiCheckDirectoryPage, WikiCheckInventoryRequest } from "../lib/wiki-check-inventory";
import { createWikiConsistencyOwner } from "./wiki-consistency-owner.svelte";

function fixture() {
  let workspace = "/project", wikiPath: string | null = "wiki";
  const listDirectory = vi.fn(async (request: WikiCheckInventoryRequest, _signal: AbortSignal): Promise<WikiCheckDirectoryPage> => ({
    entries: [{ path: `${request.path}/page.md`, kind: "file", revision: `${request.workspace}-r1`, size: 10 }],
    nextCursor: undefined,
  }));
  const readFile = vi.fn(async (_workspace: string, _wiki: string, path: string, _signal: AbortSignal) => ({ path, content: "body" }));
  const classify = vi.fn(async () => ({ status: "clear" as const, findings: [] }));
  const periodicDispose = vi.fn();
  let periodicRefresh: (() => Promise<void>) | undefined;
  const owner = createWikiConsistencyOwner({
    workspace: () => workspace, wikiPath: () => wikiPath, reportError: vi.fn(),
    listDirectory, readFile, classify, releaseInventory: vi.fn(async () => {}),
    periodic: refresh => { periodicRefresh = refresh; return { dispose: periodicDispose }; },
  });
  return {
    owner, listDirectory, readFile, classify, periodicDispose,
    tickPeriodic: () => periodicRefresh!(),
    setWorkspace(value: string) { workspace = value; }, setWikiPath(value: string | null) { wikiPath = value; },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("project-level Wiki consistency owner", () => {
  it("scans without a mounted tree and prefers the tree's observed configuration", async () => {
    const item = fixture();
    item.owner.refresh();
    await vi.runAllTimersAsync();
    expect(item.owner.summary("")).toMatchObject({ status: "clear", documents: 1 });
    expect(item.listDirectory.mock.calls[0]![0].path).toBe("wiki");

    item.owner.observeConfig("/project", "docs");
    await vi.runAllTimersAsync();
    expect(item.owner.wikiPath()).toBe("docs");
    expect(item.listDirectory.mock.calls.at(-1)![0].path).toBe("docs");
    // A different project falls back to its own loaded Wiki path.
    item.setWorkspace("/other");
    expect(item.owner.wikiPath()).toBe("wiki");
    item.owner.dispose();
  });

  it("stays idle with an unknown Wiki root and leaves no timers after dispose", async () => {
    const item = fixture();
    item.setWikiPath(null);
    item.owner.refresh();
    await vi.runAllTimersAsync();
    expect(item.listDirectory).not.toHaveBeenCalled();

    item.setWikiPath("wiki");
    await item.tickPeriodic();
    await vi.advanceTimersByTimeAsync(0);
    expect(item.listDirectory).toHaveBeenCalled();
    item.owner.dispose();
    expect(item.periodicDispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    item.owner.refresh();
    item.owner.observeConfig("/project", "docs");
    await item.tickPeriodic();
    expect(vi.getTimerCount()).toBe(0);
    expect(item.owner.findings()).toMatchObject({ findings: [], complete: false });
  });
});
