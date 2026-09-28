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
    } as any);

    const first = startup.open();
    const second = startup.open();

    expect(first).toBe(second);
    expect(listNow).toHaveBeenCalledTimes(1);

    listing.resolve({ sessions: [] });
    await first;

    expect(listNow).toHaveBeenCalledTimes(1);
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
});
