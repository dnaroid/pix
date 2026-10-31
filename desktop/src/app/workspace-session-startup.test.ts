import { describe, expect, it, vi } from "vitest";
import { createWorkspaceSessionStartup } from "./workspace-session-startup";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("workspace session startup", () => {
  it("coalesces concurrent startup calls without owning the global operation lock", async () => {
    const listing = deferred<{ sessions: never[] }>();
    const listNow = vi.fn(() => listing.promise);
    const client = {};
    const openingChanges: boolean[] = [];
    const startup = createWorkspaceSessionStartup({
      client: () => client,
      workspace: () => "/project",
      catalog: { listNow },
      tabs: {
        sessionTabsForProject: () => [],
        activeForProject: () => null,
        forgetActive: vi.fn(),
        show: vi.fn(),
        rememberActive: vi.fn(),
        restoredIds: [],
      },
      draft: { activate: vi.fn(), close: vi.fn() },
      runtime: {
        getConfigOptions: () => [],
        isReady: () => false,
        ensure: vi.fn(async () => {}),
        schedulePrewarm: vi.fn(),
      },
      history: { begin: () => 1, hydrate: vi.fn(async () => {}), cancel: vi.fn() },
      state: {
        resetConversation: vi.fn(),
        setSessionId: vi.fn(),
        setConfigOptions: vi.fn(),
        setRuntimeReady: vi.fn(),
        setTranscript: vi.fn(),
      },
      setErrorMessage: vi.fn(),
      reportError: vi.fn(),
      onOpeningChange: (opening: boolean) => openingChanges.push(opening),
    } as any);

    const first = startup.open();
    const second = startup.open();
    expect(openingChanges).toEqual([true]);

    expect(first).toBe(second);
    expect(listNow).toHaveBeenCalledTimes(1);

    listing.resolve({ sessions: [] });
    await first;

    expect(listNow).toHaveBeenCalledTimes(1);
    expect(openingChanges).toEqual([true, false]);
  });

  it("starts a new owner when the workspace changes while an old startup is pending", async () => {
    const firstListing = deferred<{ sessions: never[] }>();
    const secondListing = deferred<{ sessions: never[] }>();
    const listNow = vi.fn()
      .mockReturnValueOnce(firstListing.promise)
      .mockReturnValueOnce(secondListing.promise);
    const client = {};
    let workspace = "/one";
    const startup = createWorkspaceSessionStartup({
      client: () => client,
      workspace: () => workspace,
      catalog: { listNow },
      tabs: {
        sessionTabsForProject: () => [],
        activeForProject: () => null,
        forgetActive: vi.fn(),
        show: vi.fn(),
        rememberActive: vi.fn(),
        restoredIds: [],
      },
      draft: { activate: vi.fn(), close: vi.fn() },
      runtime: {
        getConfigOptions: () => [],
        isReady: () => false,
        ensure: vi.fn(async () => {}),
        schedulePrewarm: vi.fn(),
      },
      history: { begin: () => 1, hydrate: vi.fn(async () => {}), cancel: vi.fn() },
      state: {
        resetConversation: vi.fn(),
        setSessionId: vi.fn(),
        setConfigOptions: vi.fn(),
        setRuntimeReady: vi.fn(),
        setTranscript: vi.fn(),
      },
      setErrorMessage: vi.fn(),
      reportError: vi.fn(),
    } as any);

    const first = startup.open();
    workspace = "/two";
    const second = startup.open();

    expect(second).not.toBe(first);
    expect(listNow).toHaveBeenCalledTimes(2);

    firstListing.resolve({ sessions: [] });
    secondListing.resolve({ sessions: [] });
    await Promise.all([first, second]);
  });

  function selectionFixture() {
    const listing = deferred<{ sessions: { sessionId: string; cwd: string }[] }>();
    const client = {};
    let promptText = "";
    const state = {
      sessionId: null as string | null,
      resetConversation: vi.fn(),
      setSessionId: vi.fn((id: string | null) => { state.sessionId = id; }),
      setConfigOptions: vi.fn(),
      setRuntimeReady: vi.fn(),
      setTranscript: vi.fn(),
    };
    const draft = { open: false, active: false, activate: vi.fn(), close: vi.fn() };
    const hydrate = vi.fn(async () => {});
    const tabs = {
      sessionTabsForProject: () => ["a"],
      activeForProject: () => "a",
      forgetActive: vi.fn(),
      show: vi.fn(),
      rememberActive: vi.fn(),
      restoredIds: ["a", "b"],
    };
    const startup = createWorkspaceSessionStartup({
      client: () => client,
      workspace: () => "/project",
      catalog: { listNow: () => listing.promise },
      tabs,
      draft,
      runtime: { getConfigOptions: () => [], isReady: () => false, ensure: vi.fn(async () => {}), schedulePrewarm: vi.fn() },
      history: { begin: () => 1, hydrate, cancel: vi.fn() },
      state,
      setErrorMessage: vi.fn(),
      reportError: vi.fn(),
      promptText: () => promptText,
      promptAttachments: () => [],
    } as any);
    const sessions = [{ sessionId: "a", cwd: "/project" }, { sessionId: "b", cwd: "/project" }];
    return {
      startup, state, draft, hydrate, tabs,
      resolve: () => listing.resolve({ sessions }),
      type: (text: string) => { promptText = text; },
    };
  }

  it("restores the remembered session when the selection is untouched", async () => {
    const f = selectionFixture();
    const opening = f.startup.open();
    f.resolve();
    await opening;
    expect(f.state.setSessionId).toHaveBeenCalledWith("a");
    expect(f.hydrate).toHaveBeenCalledTimes(1);
  });

  it("keeps a tab selected by the user while the workspace listing is pending", async () => {
    const f = selectionFixture();
    const opening = f.startup.open();
    f.state.sessionId = "b";
    f.resolve();
    await opening;
    expect(f.state.sessionId).toBe("b");
    expect(f.state.resetConversation).not.toHaveBeenCalled();
    expect(f.state.setSessionId).not.toHaveBeenCalled();
    expect(f.hydrate).not.toHaveBeenCalled();
    expect(f.tabs.rememberActive).not.toHaveBeenCalled();
  });

  it("does not reset or close a draft the user opened or typed into while opening", async () => {
    const f = selectionFixture();
    f.draft.open = true;
    f.draft.active = true;
    const opening = f.startup.open();
    f.type("unsent text");
    f.resolve();
    await opening;
    expect(f.draft.activate).not.toHaveBeenCalled();
    expect(f.draft.close).not.toHaveBeenCalled();
    expect(f.state.setSessionId).not.toHaveBeenCalled();
  });
});
