import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpClient } from "./acp-client";
import {
  BACKGROUND_SHELL_STATE_CHANNEL,
  backgroundJobTailLines,
  backgroundJobsSnapshot,
  parseBackgroundJobsSnapshot,
  workspaceRelativePath,
} from "./background-jobs";
import { createBackgroundJobsStore } from "../app/background-jobs.svelte";

const job = (id: string, status = "running", extra: Record<string, unknown> = {}) => ({
  id, command: `npm run ${id}`, status, startedAt: 1, logPath: `/w/.pi/artifacts/background-shell/s/${id}.log`, tail: "a\nb\n", ...extra,
});
const push = (checkedAt: number, jobs: unknown[], orphans: unknown[] = []) => ({ sessionId: "s1", channel: BACKGROUND_SHELL_STATE_CHANNEL, data: { checkedAt, running: 99, jobs, orphans } });

afterEach(() => vi.restoreAllMocks());

describe("background jobs contract", () => {
  it("parses snapshots defensively and recomputes the live count", () => {
    const parsed = parseBackgroundJobsSnapshot({ checkedAt: 5, running: 99, jobs: [job("a"), job("b", "exited", { exitCode: 0 }), { id: 1 }, job("c", "bogus")],
      orphans: [{ pid: 7, command: "x", startedAt: 2, logPath: "/l", jobId: "bg_1" }, { pid: "no" }] });
    expect(parsed?.jobs.map((item) => item.id)).toEqual(["a", "b"]);
    expect(parsed?.running).toBe(1);
    expect(parsed?.orphans).toHaveLength(1);
    expect(parseBackgroundJobsSnapshot({ jobs: [] })).toBeUndefined();
    expect(backgroundJobsSnapshot({ sessionId: "s", channel: "other", data: { checkedAt: 1, jobs: [] } })).toBeUndefined();
  });

  it("bounds tails and resolves workspace-relative log paths", () => {
    expect(backgroundJobTailLines("1\n2\n3\n4\n\n\n", 2)).toBe("3\n4");
    expect(workspaceRelativePath("/w/", "/w/.pi/artifacts/x.log")).toBe(".pi/artifacts/x.log");
    expect(workspaceRelativePath("/w", "/other/x.log")).toBeUndefined();
    expect(workspaceRelativePath("/w", "/wx/x.log")).toBeUndefined();
  });
});

describe("background jobs store", () => {
  function setup(ready = true) {
    const prompt = vi.fn(async (..._args: unknown[]) => {});
    const reportError = vi.fn();
    let client: AcpClient | null = { prompt } as unknown as AcpClient;
    const store = createBackgroundJobsStore({ client: () => client, runtimeReady: () => ready, reportError });
    return { store, prompt, reportError, setClient: (next: AcpClient | null) => { client = next; } };
  }

  it("isolates sessions, ignores older snapshots and clears on forget/reset", () => {
    const { store } = setup();
    expect(store.handleSessionState({ sessionId: "s1", channel: "todo", data: {} })).toBe(false);
    expect(store.handleSessionState(push(10, [job("a")]))).toBe(true);
    store.handleSessionState(push(5, []));
    expect(store.state("s1")?.jobs).toHaveLength(1);
    expect(store.state("s2")).toBeUndefined();
    store.clearSession("s1");
    expect(store.state("s1")).toBeUndefined();
    store.handleSessionState(push(11, [job("a")]));
    store.reset();
    expect(store.state("s1")).toBeUndefined();
  });

  it("sends kill commands once while pending and only to a ready runtime", async () => {
    const h = setup();
    let release!: () => void;
    h.prompt.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = h.store.kill("s1", "bg_1");
    void h.store.kill("s1", "bg_1");
    expect(h.store.isPending("s1", "/background-jobs kill bg_1")).toBe(true);
    release();
    await first;
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(h.prompt.mock.calls[0]?.[1]).toEqual([{ type: "text", text: "/background-jobs kill bg_1" }]);
    expect(h.store.isPending("s1", "/background-jobs kill bg_1")).toBe(false);
    await h.store.killAll("s1");
    await h.store.killOrphans("s1");
    expect(h.prompt.mock.calls.map((call) => (call[1] as Array<{ text: string }>)[0]?.text)).toEqual([
      "/background-jobs kill bg_1", "/background-jobs kill-all", "/background-jobs kill-orphans"]);
    const idle = setup(false);
    await idle.store.kill("s1", "bg_1");
    expect(idle.prompt).not.toHaveBeenCalled();
  });

  it("drops errors from requests invalidated by reset or a client swap", async () => {
    const h = setup();
    h.prompt.mockRejectedValueOnce(new Error("boom"));
    await h.store.kill("s1", "bg_1");
    expect(h.reportError).toHaveBeenCalledTimes(1);
    let reject!: (error: Error) => void;
    h.prompt.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const stale = h.store.kill("s1", "bg_2");
    h.store.reset();
    reject(new Error("late"));
    await stale;
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.store.isPending("s1", "/background-jobs kill bg_2")).toBe(false);
  });
});
