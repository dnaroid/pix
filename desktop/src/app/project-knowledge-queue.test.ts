import { describe, expect, it, vi } from "vitest";
import { createProjectKnowledgeQueue, MAX_ACTIVE_KNOWLEDGE_JOBS, MAX_KNOWLEDGE_JOB_HISTORY, type ManualKnowledgeCheckInput, type ProjectKnowledgeJob } from "./project-knowledge-queue.svelte";
import { MAX_KNOWLEDGE_DOCUMENT_CHARS, type KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function result(path: string, content: string, status: KnowledgeCheckResult["status"] = "clear"): Promise<KnowledgeCheckResult> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return { status, path, documentHash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
    modelRef: "test/model", checkedSources: 1, conflicts: [], notices: status === "incomplete" ? ["Some evidence was unavailable."] : [] };
}

const input = (path = "wiki/page.md", content = "Saved body", persistStamp = true): ManualKnowledgeCheckInput => ({
  path, content, expectedContent: content, persistStamp,
});

function fixture() {
  let workspace = "/project";
  const check = vi.fn(async (job: ProjectKnowledgeJob, _signal: AbortSignal) => result(job.path, job.content));
  const record = vi.fn(async (_job: ProjectKnowledgeJob, _result: KnowledgeCheckResult, _current: () => boolean) => true);
  const reportError = vi.fn(), reportBackgroundError = vi.fn(), onComplete = vi.fn();
  const recordFailure = vi.fn(async (_job: ProjectKnowledgeJob, _current: () => boolean) => true);
  const queue = createProjectKnowledgeQueue({ workspace: () => workspace, check, record, recordFailure, reportError, reportBackgroundError, onComplete });
  return { queue, check, record, recordFailure, reportError, reportBackgroundError, onComplete, changeWorkspace: () => { workspace = "/other-project"; } };
}

describe("project-owned manual Wiki queue", () => {
  it("accepts a 54k saved page and binds the result to its full document hash", async () => {
    const item = fixture(), content = "Wiki body\n".repeat(5_400);
    expect(content).toHaveLength(54_000);
    const id = item.queue.enqueue(input("wiki/long.md", content));
    expect(id).toBeDefined();
    await vi.waitFor(() => expect(item.queue.jobs.find(job => job.id === id)?.state).toBe("completed"));
    expect(item.check.mock.calls[0]?.[0]).toMatchObject({ content, expectedContent: content });
    expect(item.queue.jobs.find(job => job.id === id)?.result?.documentHash).toBe((await result("wiki/long.md", content)).documentHash);
    expect(item.record.mock.calls[0]?.[0]).toMatchObject({ content, expectedContent: content });
    expect(item.reportError).not.toHaveBeenCalled();
  });

  it("runs immutable snapshots FIFO and retains completed reports", async () => {
    const item = fixture();
    const first = deferred<KnowledgeCheckResult>();
    item.check.mockReturnValueOnce(first.promise);
    const source = { ...input("wiki/first.md") };
    const firstId = item.queue.enqueue(source)!;
    source.content = "Changed after enqueue";
    const secondId = item.queue.enqueue(input("wiki/second.md"))!;
    await vi.waitFor(() => expect(item.check).toHaveBeenCalledTimes(1));
    expect(item.check.mock.calls[0]?.[0]).toMatchObject({ path: "wiki/first.md", content: "Saved body", expectedContent: "Saved body" });
    expect(item.queue.jobs.find(job => job.id === secondId)?.state).toBe("queued");
    first.resolve(await result("wiki/first.md", "Saved body"));
    await vi.waitFor(() => expect(item.queue.jobs.every(job => job.state === "completed")).toBe(true));
    expect(item.check.mock.calls.map(([job]) => job.path)).toEqual(["wiki/first.md", "wiki/second.md"]);
    expect(item.queue.jobs.map(job => job.id)).toEqual([firstId, secondId]);
    expect(item.onComplete).toHaveBeenCalledTimes(2);
    expect(item.record).toHaveBeenCalledTimes(2);
  });

  it("deduplicates identical active requests while retaining distinct snapshots", async () => {
    const item = fixture(), pending = deferred<KnowledgeCheckResult>();
    item.check.mockReturnValueOnce(pending.promise);
    const id = item.queue.enqueue(input())!;
    expect(item.queue.enqueue(input())).toBe(id);
    expect(item.queue.enqueue(input("wiki/page.md", "New body"))).not.toBe(id);
    await vi.waitFor(() => expect(item.check).toHaveBeenCalledTimes(1));
    expect(item.queue.enqueue(input())).toBe(id);
    expect(item.queue.jobs).toHaveLength(2);
    pending.resolve(await result("wiki/page.md", "Saved body"));
    await vi.waitFor(() => expect(item.queue.jobs.every(job => job.state === "completed")).toBe(true));
    expect(item.queue.find("wiki/page.md", "Saved body")?.id).toBe(id);
    expect(item.queue.find("wiki/page.md", "Unreviewed body")).toBeUndefined();
  });

  it("skips a cancelled waiting task without calling the backend or notifying", async () => {
    const item = fixture(), pending = deferred<KnowledgeCheckResult>();
    item.check.mockReturnValueOnce(pending.promise);
    item.queue.enqueue(input("wiki/first.md"));
    const cancelled = item.queue.enqueue(input("wiki/second.md"))!;
    item.queue.cancel(cancelled);
    await vi.waitFor(() => expect(item.check).toHaveBeenCalledTimes(1));
    pending.resolve(await result("wiki/first.md", "Saved body"));
    await vi.waitFor(() => expect(item.onComplete).toHaveBeenCalledTimes(1));
    expect(item.queue.jobs.find(job => job.id === cancelled)?.state).toBe("cancelled");
    expect(item.check).toHaveBeenCalledTimes(1);
  });

  it("holds the execution slot after cancellation until an abort-ignoring backend settles", async () => {
    const item = fixture(), pending = deferred<KnowledgeCheckResult>();
    item.check.mockReturnValueOnce(pending.promise);
    const cancelled = item.queue.enqueue(input("wiki/first.md"))!;
    const next = item.queue.enqueue(input("wiki/second.md"))!;
    await vi.waitFor(() => expect(item.check).toHaveBeenCalledTimes(1));
    item.queue.cancel(cancelled);
    expect(item.check.mock.calls[0]?.[1].aborted).toBe(true);
    await Promise.resolve();
    expect(item.check).toHaveBeenCalledTimes(1);
    expect(item.queue.jobs.find(job => job.id === next)?.state).toBe("queued");
    pending.resolve(await result("wiki/first.md", "Saved body"));
    await vi.waitFor(() => expect(item.queue.jobs.find(job => job.id === next)?.state).toBe("completed"));
    expect(item.record.mock.calls.map(([job]) => job.id)).toEqual([next]);
    expect(item.onComplete.mock.calls.map(([job]) => job.id)).toEqual([next]);
    expect(item.reportError).not.toHaveBeenCalled();
  });

  it("resets ownership and prevents stale writes or notifications after a project change", async () => {
    const item = fixture(), pending = deferred<KnowledgeCheckResult>();
    item.check.mockReturnValueOnce(pending.promise);
    const oldId = item.queue.enqueue(input())!;
    await vi.waitFor(() => expect(item.check).toHaveBeenCalledTimes(1));
    item.queue.reset();
    item.changeWorkspace();
    const newId = item.queue.enqueue(input())!;
    expect(newId).not.toBe(oldId);
    expect(item.queue.jobs).toHaveLength(1);
    await Promise.resolve();
    expect(item.check).toHaveBeenCalledTimes(1);
    pending.resolve(await result("wiki/page.md", "Saved body"));
    await vi.waitFor(() => expect(item.queue.jobs[0]?.state).toBe("completed"));
    expect(item.record.mock.calls.map(([job]) => [job.id, job.workspace])).toEqual([[newId, "/other-project"]]);
    expect(item.onComplete).toHaveBeenCalledTimes(1);
    expect(item.reportError).not.toHaveBeenCalled();
  });

  it("also rejects a late response when the workspace accessor changes before reset", async () => {
    const item = fixture(), pending = deferred<KnowledgeCheckResult>();
    item.check.mockReturnValueOnce(pending.promise);
    item.queue.enqueue(input());
    await vi.waitFor(() => expect(item.check).toHaveBeenCalledTimes(1));
    item.changeWorkspace();
    pending.resolve(await result("wiki/page.md", "Saved body"));
    await vi.waitFor(() => expect(item.queue.jobs[0]?.state).toBe("cancelled"));
    expect(item.record).not.toHaveBeenCalled();
    expect(item.onComplete).not.toHaveBeenCalled();
    expect(item.queue.find("wiki/page.md", "Saved body")).toBeUndefined();
  });

  it("retains failures, logs once, notifies once, and continues with the next task", async () => {
    const item = fixture();
    const failure = new Error("Backend disconnected");
    item.check.mockRejectedValueOnce(failure);
    const failed = item.queue.enqueue(input("wiki/first.md"))!;
    const next = item.queue.enqueue(input("wiki/second.md"))!;
    await vi.waitFor(() => expect(item.queue.jobs.find(job => job.id === next)?.state).toBe("completed"));
    expect(item.queue.jobs.find(job => job.id === failed)).toMatchObject({ state: "failed", error: "Backend disconnected" });
    expect(item.reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(item.onComplete.mock.calls.map(([job]) => job.state)).toEqual(["failed", "completed"]);
    expect(item.record).toHaveBeenCalledTimes(1);
  });

  it.each(["path", "hash"] as const)("does not attach or stamp a response with a mismatched %s", async field => {
    const item = fixture();
    const wrong = await result(field === "path" ? "wiki/other.md" : "wiki/page.md", field === "hash" ? "Different body" : "Saved body");
    item.check.mockResolvedValueOnce(wrong);
    item.queue.enqueue(input());
    await vi.waitFor(() => expect(item.queue.jobs[0]?.state).toBe("failed"));
    expect(item.queue.jobs[0]?.result).toBeUndefined();
    expect(item.record).not.toHaveBeenCalled();
    expect(item.reportError).toHaveBeenCalledTimes(1);
  });

  it("retains a completed report when recording fails and never records unsaved drafts", async () => {
    const item = fixture();
    item.record.mockResolvedValueOnce(false);
    const saved = item.queue.enqueue(input())!;
    const draft = item.queue.enqueue({ ...input("wiki/draft.md", "Unsaved body", false), expectedContent: "Saved body" })!;
    await vi.waitFor(() => expect(item.queue.jobs.find(job => job.id === draft)?.state).toBe("completed"));
    expect(item.queue.jobs.find(job => job.id === saved)).toMatchObject({ state: "completed", recorded: false, result: { status: "clear" } });
    expect(item.queue.jobs.find(job => job.id === saved)?.error).toMatch(/could not be saved in the file/);
    expect(item.queue.jobs.find(job => job.id === draft)?.recorded).toBeUndefined();
    expect(item.record).toHaveBeenCalledTimes(1);
  });

  it("bounds active snapshots, rejects oversize input, and never evicts active tasks", async () => {
    const item = fixture(), pending = deferred<KnowledgeCheckResult>();
    item.check.mockReturnValueOnce(pending.promise);
    expect(item.queue.enqueue(input("wiki/huge.md", "x".repeat(MAX_KNOWLEDGE_DOCUMENT_CHARS + 1)))).toBeUndefined();
    const ids = Array.from({ length: MAX_ACTIVE_KNOWLEDGE_JOBS }, (_, index) => item.queue.enqueue(input(`wiki/${index}.md`)));
    expect(ids.every(id => id !== undefined)).toBe(true);
    expect(item.queue.enqueue(input("wiki/excess.md"))).toBeUndefined();
    item.queue.dismiss(ids[0]!);
    expect(item.queue.jobs.map(job => job.id)).toEqual(ids);
    expect(item.reportError).toHaveBeenCalledTimes(2);
    item.queue.reset();
    pending.resolve(await result("wiki/0.md", "Saved body"));
  });

  it("bounds completed history and supports explicit dismissal without discarding active jobs", async () => {
    const item = fixture();
    for (let index = 0; index < MAX_KNOWLEDGE_JOB_HISTORY + 2; index++) {
      const id = item.queue.enqueue(input(`wiki/${index}.md`))!;
      await vi.waitFor(() => expect(item.queue.jobs.find(job => job.id === id)?.state).toBe("completed"));
    }
    expect(item.queue.jobs).toHaveLength(MAX_KNOWLEDGE_JOB_HISTORY);
    expect(item.queue.jobs[0]?.path).toBe("wiki/2.md");
    const retained = item.queue.jobs.at(-1)!;
    item.queue.dismiss(retained.id);
    expect(item.queue.jobs.some(job => job.id === retained.id)).toBe(false);
  });

  it("refuses to persist a draft as though it were the saved baseline", () => {
    const item = fixture();
    expect(item.queue.enqueue({ ...input(), content: "Unsaved changes" })).toBeUndefined();
    expect(item.queue.jobs).toEqual([]);
    expect(item.check).not.toHaveBeenCalled();
    expect(item.reportError).toHaveBeenCalledTimes(1);
  });
});


const background = (path: string, content = "Saved body"): ManualKnowledgeCheckInput => ({
  ...input(path, content), origin: "background", autoCheckRunId: "test-pass",
});

describe("automatic Wiki work shares the manual queue", () => {
  it("runs waiting manual requests first without preempting the running automatic check", async () => {
    const item = fixture(), first = deferred<KnowledgeCheckResult>();
    item.check.mockReturnValueOnce(first.promise);
    item.queue.enqueue(background("wiki/running.md"));
    await vi.waitFor(() => expect(item.check).toHaveBeenCalledTimes(1));
    item.queue.enqueue(background("wiki/background.md"));
    item.queue.enqueue(input("wiki/manual.md"));
    first.resolve(await result("wiki/running.md", "Saved body"));
    await vi.waitFor(() => expect(item.queue.jobs.every(job => job.state === "completed")).toBe(true));
    expect(item.check.mock.calls.map(([job]) => job.path)).toEqual(["wiki/running.md", "wiki/manual.md", "wiki/background.md"]);
    expect(item.check.mock.calls[0]?.[1].aborted).toBe(false);
  });

  it("promotes an identical waiting automatic snapshot instead of creating a second task", async () => {
    const item = fixture(), first = deferred<KnowledgeCheckResult>();
    item.check.mockReturnValueOnce(first.promise);
    item.queue.enqueue(input("wiki/running.md"));
    await vi.waitFor(() => expect(item.check).toHaveBeenCalledTimes(1));
    item.queue.enqueue(background("wiki/earlier.md"));
    const promoted = item.queue.enqueue(background("wiki/promoted.md"));
    expect(item.queue.enqueue(input("wiki/promoted.md"))).toBe(promoted);
    expect(item.queue.jobs).toHaveLength(3);
    first.resolve(await result("wiki/running.md", "Saved body"));
    await vi.waitFor(() => expect(item.queue.jobs.every(job => job.state === "completed")).toBe(true));
    expect(item.check.mock.calls.map(([job]) => job.path)).toEqual(["wiki/running.md", "wiki/promoted.md", "wiki/earlier.md"]);
    expect(item.record.mock.calls[1]?.[0].autoCheckRunId).toBe("test-pass");
  });

  it("disabling automatic work cancels only its waiting tasks", async () => {
    const item = fixture(), first = deferred<KnowledgeCheckResult>();
    item.check.mockReturnValueOnce(first.promise);
    const running = item.queue.enqueue(background("wiki/running.md"))!;
    await vi.waitFor(() => expect(item.check).toHaveBeenCalledTimes(1));
    const cancelled = item.queue.enqueue(background("wiki/waiting.md"))!;
    const manual = item.queue.enqueue(input("wiki/manual.md"))!;
    item.queue.cancelQueuedBackground();
    expect(item.queue.jobs.find(job => job.id === cancelled)?.state).toBe("cancelled");
    expect(item.queue.jobs.find(job => job.id === running)?.state).toBe("running");
    expect(item.check.mock.calls[0]?.[1].aborted).toBe(false);
    first.resolve(await result("wiki/running.md", "Saved body"));
    await vi.waitFor(() => expect(item.queue.jobs.find(job => job.id === manual)?.state).toBe("completed"));
    expect(item.check.mock.calls.map(([job]) => job.path)).toEqual(["wiki/running.md", "wiki/manual.md"]);
  });

  it("reserves capacity for manual requests and treats automatic backpressure quietly", () => {
    const item = fixture();
    for (let index = 0; index < MAX_ACTIVE_KNOWLEDGE_JOBS - 1; index++) {
      expect(item.queue.enqueue(background(`wiki/background-${index}.md`))).toBeDefined();
    }
    expect(item.queue.enqueue(background("wiki/later.md"))).toBeUndefined();
    expect(item.queue.enqueue(input("wiki/manual.md"))).toBeDefined();
    expect(item.reportError).not.toHaveBeenCalled();
    expect(item.reportBackgroundError).not.toHaveBeenCalled();
    item.queue.reset();
  });

  it("logs automatic failures quietly and durably records the attempted version", async () => {
    const item = fixture(), error = new Error("Judge unavailable");
    item.check.mockRejectedValueOnce(error);
    item.queue.enqueue(background("wiki/page.md"));
    await vi.waitFor(() => expect(item.queue.jobs[0]?.state).toBe("failed"));
    expect(item.reportBackgroundError).toHaveBeenCalledExactlyOnceWith(error);
    expect(item.reportError).not.toHaveBeenCalled();
    expect(item.recordFailure).toHaveBeenCalledTimes(1);
    expect(item.recordFailure.mock.calls[0]?.[0]).toMatchObject({ path: "wiki/page.md", autoCheckRunId: "test-pass", expectedContent: "Saved body" });
    expect(item.queue.jobs[0]?.recorded).toBe(true);
    expect(item.onComplete).toHaveBeenCalledTimes(1);
  });

  it("retains the physical slot during failure recording and fences cancellation", async () => {
    const item = fixture(), recording = deferred<boolean>();
    item.check.mockRejectedValueOnce(new Error("Judge unavailable"));
    item.recordFailure.mockReturnValueOnce(recording.promise);
    const cancelled = item.queue.enqueue(background("wiki/page.md"))!;
    await vi.waitFor(() => expect(item.recordFailure).toHaveBeenCalledTimes(1));
    const next = item.queue.enqueue(input("wiki/next.md"))!;
    item.queue.cancel(cancelled);
    expect(item.recordFailure.mock.calls[0]?.[1]()).toBe(false);
    const later = item.queue.enqueue(input("wiki/later.md"))!;
    const calls = item.check.mock.calls.length;
    await Promise.resolve();
    expect(item.check).toHaveBeenCalledTimes(calls);
    recording.resolve(true);
    await vi.waitFor(() => expect(item.queue.jobs.find(job => job.id === later)?.state).toBe("completed"));
    expect(item.onComplete.mock.calls.some(([job]) => job.id === cancelled)).toBe(false);
    expect(item.queue.jobs.find(job => job.id === next)?.state).toBe("completed");
  });

  it("rejects automatic draft-only work without using the manual error channel", () => {
    const item = fixture();
    expect(item.queue.enqueue({ ...background("wiki/page.md"), persistStamp: false })).toBeUndefined();
    expect(item.reportBackgroundError).toHaveBeenCalledTimes(1);
    expect(item.reportError).not.toHaveBeenCalled();
    expect(item.queue.jobs).toEqual([]);
  });
});


it.each([true, false])("allows the owner to checkpoint a failed manual saved request only when persistStamp=%s", async persistStamp => {
  const item = fixture(), failure = new Error("Judge unavailable");
  item.check.mockRejectedValueOnce(failure);
  item.queue.enqueue(input("wiki/manual.md", "Saved body", persistStamp));
  await vi.waitFor(() => expect(item.queue.jobs[0]?.state).toBe("failed"));
  expect(item.recordFailure).toHaveBeenCalledTimes(persistStamp ? 1 : 0);
  expect(item.reportError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(item.reportBackgroundError).not.toHaveBeenCalled();
  expect(item.queue.jobs[0]?.recorded).toBe(persistStamp ? true : undefined);
});
