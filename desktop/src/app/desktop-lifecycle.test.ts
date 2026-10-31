import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/desktop-file-drop", () => ({ installDesktopFileDrop: () => () => {} }));

import { createDesktopLifecycle } from "./desktop-lifecycle";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {} });
  const connect = deferred();
  const disposed = deferred();
  const events: string[] = [];
  const options = {
    activeSessionId: () => null,
    activeSessionRuntimeReady: () => false,
    refreshRuntimeStatus: vi.fn(),
    disposeGitCi: vi.fn(),
    restoreProjects: vi.fn(),
    refreshProjectColors: vi.fn(),
    workspace: () => "",
    loadWorkspaceData: vi.fn(),
    canAcceptDroppedAttachments: () => false,
    setDragActive: vi.fn(),
    activeCustomQuestionId: () => null,
    addQuestionImagePaths: vi.fn(),
    canInsertPromptAttachments: () => false,
    insertPromptPaths: vi.fn(),
    connect: () => connect.promise,
    disposeConnection: vi.fn(() => { events.push("dispose"); return disposed.promise; }),
    resetAfterDisconnect: vi.fn(() => { events.push("reset"); }),
    disposeSessionUpdates: vi.fn(),
    disposeTranscriptScroll: vi.fn(),
    cancelAllPendingElicitations: vi.fn(),
    reportError: vi.fn(),
  };
  return { lifecycle: createDesktopLifecycle(options), options, connect, disposed, events };
}

describe("desktop lifecycle teardown", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resets runtime state on teardown and again after the connection settles", async () => {
    const { lifecycle, disposed, events } = setup();
    const stop = lifecycle.start();
    stop();
    expect(events).toEqual(["dispose", "reset"]);
    disposed.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["dispose", "reset", "reset"]);
  });

  it("resets after a connect that completes after teardown", async () => {
    const { lifecycle, connect, disposed, options } = setup();
    const stop = lifecycle.start();
    stop();
    disposed.resolve();
    connect.resolve();
    await vi.waitFor(() => expect(options.resetAfterDisconnect).toHaveBeenCalledTimes(4));
    expect(options.disposeConnection).toHaveBeenCalledTimes(2);
  });

  it("reports a failing reset instead of breaking teardown", () => {
    const { lifecycle, options } = setup();
    options.resetAfterDisconnect.mockImplementation(() => { throw new Error("reset failed"); });
    const stop = lifecycle.start();
    expect(() => stop()).not.toThrow();
    expect(options.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "reset failed" }));
  });
});
