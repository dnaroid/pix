import { describe, expect, it, vi } from "vitest";
import { searchGitHistory } from "./git-history-search";

describe("searchGitHistory", () => {
  it("passes a request id and cancels the backend walk when the search aborts", async () => {
    let resolveSearch: (value: unknown) => void = () => {};
    const invoke = vi.fn((command: string) => command === "git_search_history"
      ? new Promise(resolve => { resolveSearch = resolve; })
      : Promise.resolve());
    const controller = new AbortController();
    const pending = searchGitHistory(invoke as never, "/repo", "needle", controller.signal);
    const [, args] = invoke.mock.calls[0] as unknown as [string, { requestId: string; workspace: string; query: string }];
    expect(args).toMatchObject({ workspace: "/repo", query: "needle" });
    expect(args.requestId).toMatch(/^[0-9a-f-]{36}$/);

    controller.abort();
    expect(invoke).toHaveBeenCalledWith("git_search_history_cancel", { requestId: args.requestId });
    resolveSearch([]);
    await expect(pending).rejects.toThrow();
  });

  it("does not start or cancel after completion", async () => {
    const invoke = vi.fn(async () => [{ hash: "a", shortHash: "a", subject: "s", author: "me", date: "d" }]);
    const controller = new AbortController();
    await expect(searchGitHistory(invoke as never, "/repo", "s", controller.signal)).resolves.toHaveLength(1);
    controller.abort();
    expect(invoke).toHaveBeenCalledTimes(1);

    const aborted = new AbortController();
    aborted.abort();
    await expect(searchGitHistory(invoke as never, "/repo", "s", aborted.signal)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
