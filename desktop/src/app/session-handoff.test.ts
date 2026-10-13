import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import type { PromptRunCompletion } from "./prompt-run-lifecycle.svelte";
import { createSessionHandoff } from "./session-handoff.svelte";
import { SESSION_HANDOFF_COMPLETE, isCompleteSessionHandoff, sessionHandoffPath, sessionHandoffContinuationPrompt } from "./session-handoff-prompts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const current = { sessionId: "source", workspace: "/project", owns: true, idle: true };
  const client = {
    newSession: vi.fn().mockResolvedValue({ sessionId: "fresh", configOptions: [] }),
    loadSession: vi.fn().mockResolvedValue({ configOptions: [] }),
    closeSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as AcpClient;
  let activeClient: AcpClient = client;
  const completion: PromptRunCompletion = { stopReason: "end_turn", isCurrent: () => current.owns };
  const release = vi.fn();
  const options = {
    client: () => activeClient,
    workspace: () => current.workspace,
    sessionId: () => current.sessionId,
    canStart: () => true,
    captureOwnership: () => () => current.owns,
    isIdle: () => current.idle,
    holdAutoQueue: vi.fn(() => release),
    runPrompt: vi.fn().mockResolvedValue(completion),
    readHandoff: vi.fn(async (_workspace: string, _path: string) => `## Continue\nFix the remaining regression.\n${SESSION_HANDOFF_COMPLETE}`),
    commitSession: vi.fn((_source: string, target: string) => { current.sessionId = target; }),
    discardSession: vi.fn(),
    reportError: vi.fn(),
  };
  return { current, client, completion, options, release, handoff: createSessionHandoff(options),
    replaceClient: () => { activeClient = {} as AcpClient; } };
}

describe("session handoff", () => {
  it("prepares the fresh runtime off-screen, then replaces only the source and sends continuation", async () => {
    const f = fixture();
    const prepared = deferred<{ configOptions: [] }>();
    vi.mocked(f.client.loadSession).mockReturnValue(prepared.promise);
    const pending = f.handoff.start();
    await vi.waitFor(() => expect(f.client.loadSession).toHaveBeenCalledWith("fresh", "/project"));
    expect(f.current.sessionId).toBe("source");
    expect(f.handoff.busySessionId).toBe("source");
    expect(f.options.commitSession).not.toHaveBeenCalled();
    expect(f.options.runPrompt).toHaveBeenCalledTimes(1);
    prepared.resolve({ configOptions: [] });
    await pending;
    const path = f.options.readHandoff.mock.calls[0]![1];
    expect(path).toMatch(/^\.pi\/artifacts\/handoff-[\w-]+\/handoff\.md$/);
    expect(f.options.runPrompt).toHaveBeenNthCalledWith(1, f.client, "source", expect.stringContaining(path));
    expect(f.options.commitSession).toHaveBeenCalledWith("source", "fresh", []);
    expect(f.options.runPrompt).toHaveBeenNthCalledWith(2, f.client, "fresh", sessionHandoffContinuationPrompt(path));
    expect(f.client.closeSession).not.toHaveBeenCalled();
    expect(f.handoff.busySessionId).toBeNull();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "max_tokens", "refusal"] as const)("keeps the source after %s", async (stopReason) => {
    const f = fixture();
    f.options.runPrompt.mockResolvedValue({ ...f.completion, stopReason });
    await f.handoff.start();
    expect(f.options.readHandoff).not.toHaveBeenCalled();
    expect(f.client.newSession).not.toHaveBeenCalled();
    expect(f.current.sessionId).toBe("source");
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.options.reportError).toHaveBeenCalledTimes(stopReason === "cancelled" ? 0 : 1);
  });

  it.each(["", "partial document", SESSION_HANDOFF_COMPLETE])("rejects incomplete files (%s)", async (content) => {
    const f = fixture();
    f.options.readHandoff.mockResolvedValue(content);
    await f.handoff.start();
    expect(f.client.newSession).not.toHaveBeenCalled();
    expect(f.current.sessionId).toBe("source");
    expect(f.options.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("incomplete") }));
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["prompt", "file", "create", "load"] as const)("does not publish a session when %s fails", async (stage) => {
    const f = fixture();
    const failure = new Error(`${stage} failed`);
    if (stage === "prompt") f.options.runPrompt.mockRejectedValue(failure);
    if (stage === "file") f.options.readHandoff.mockRejectedValue(failure);
    if (stage === "create") vi.mocked(f.client.newSession).mockRejectedValue(failure);
    if (stage === "load") vi.mocked(f.client.loadSession).mockRejectedValue(failure);
    await f.handoff.start();
    expect(f.current.sessionId).toBe("source");
    expect(f.options.commitSession).not.toHaveBeenCalled();
    expect(f.options.reportError).toHaveBeenCalledWith(failure);
    expect(f.client.closeSession).toHaveBeenCalledTimes(stage === "load" ? 1 : 0);
    expect(f.options.discardSession).toHaveBeenCalledTimes(stage === "load" ? 1 : 0);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["session", "workspace", "client", "away and back", "new run", "not idle", "mutation"] as const)(
    "discards a prepared runtime without stealing navigation after %s changes", async (change) => {
      const f = fixture();
      const prepared = deferred<{ configOptions: [] }>();
      vi.mocked(f.client.loadSession).mockReturnValue(prepared.promise);
      const pending = f.handoff.start();
      await vi.waitFor(() => expect(f.client.loadSession).toHaveBeenCalledOnce());
      if (change === "session") f.current.sessionId = "other";
      if (change === "workspace") f.current.workspace = "/other";
      if (change === "client") f.replaceClient();
      if (change === "away and back" || change === "new run") f.current.owns = false;
      if (change === "not idle") f.current.idle = false;
      if (change === "mutation") f.options.canStart = () => false;
      prepared.resolve({ configOptions: [] });
      await pending;
      expect(f.options.commitSession).not.toHaveBeenCalled();
      expect(f.options.runPrompt).toHaveBeenCalledTimes(1);
      expect(f.options.discardSession).toHaveBeenCalledWith("fresh");
      expect(f.client.closeSession).toHaveBeenCalledWith("fresh");
      expect(f.options.reportError).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it("rejects a stale end_turn before reading the handoff", async () => {
    const f = fixture();
    f.options.runPrompt.mockResolvedValue({ ...f.completion, isCurrent: () => false });
    await f.handoff.start();
    expect(f.options.readHandoff).not.toHaveBeenCalled();
    expect(f.options.commitSession).not.toHaveBeenCalled();
  });

  it.each(["generation", "file", "create"] as const)("rejects navigation changes while awaiting %s", async (stage) => {
    const f = fixture();
    const barrier = deferred<any>();
    if (stage === "generation") f.options.runPrompt.mockReturnValue(barrier.promise);
    if (stage === "file") f.options.readHandoff.mockReturnValue(barrier.promise);
    if (stage === "create") vi.mocked(f.client.newSession).mockReturnValue(barrier.promise);
    const pending = f.handoff.start();
    await vi.waitFor(() => {
      const reached = stage === "generation" ? f.options.runPrompt : stage === "file" ? f.options.readHandoff : f.client.newSession;
      expect(reached).toHaveBeenCalledOnce();
    });
    f.current.owns = false;
    barrier.resolve(stage === "generation" ? f.completion : stage === "file" ? `Body\n${SESSION_HANDOFF_COMPLETE}` : { sessionId: "fresh" });
    await pending;
    expect(f.options.commitSession).not.toHaveBeenCalled();
    expect(f.client.loadSession).not.toHaveBeenCalled();
    expect(f.client.closeSession).toHaveBeenCalledTimes(stage === "create" ? 1 : 0);
    expect(f.options.runPrompt).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("rejects duplicate clicks while generation is pending and starts nothing when disabled", async () => {
    const f = fixture();
    const generated = deferred<PromptRunCompletion>();
    f.options.runPrompt.mockReturnValue(generated.promise);
    const first = f.handoff.start();
    await f.handoff.start();
    expect(f.options.runPrompt).toHaveBeenCalledOnce();
    generated.resolve({ ...f.completion, stopReason: "cancelled" });
    await first;
    f.options.canStart = () => false;
    await f.handoff.start();
    expect(f.options.runPrompt).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("retains the fresh session and reports continuation failures for retry", async () => {
    const f = fixture();
    const failure = new Error("continuation failed");
    f.options.runPrompt.mockResolvedValueOnce(f.completion).mockRejectedValueOnce(failure);
    await f.handoff.start();
    expect(f.current.sessionId).toBe("fresh");
    expect(f.options.reportError).toHaveBeenCalledWith(failure);
    expect(f.client.closeSession).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("uses unique scratch paths and requires a completion footer", () => {
    expect(sessionHandoffPath()).not.toBe(sessionHandoffPath());
    expect(isCompleteSessionHandoff(`Body\n${SESSION_HANDOFF_COMPLETE}\n`)).toBe(true);
    expect(isCompleteSessionHandoff(`${SESSION_HANDOFF_COMPLETE}\npartial`)).toBe(false);
  });
});
