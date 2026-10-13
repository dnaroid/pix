import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestNative } from "./native-repository-search";
import { readSearchSourceSelection, setSearchSourceSelection, SEARCH_SOURCE_SELECTION_CHANGED } from "./search-source-selection";

vi.mock("./native-repository-search", () => ({ requestNative: vi.fn() }));
const transport = vi.mocked(requestNative);
const enabled = { settings: true, code: true, knowledge: false, sessions: false, tasks: false, commits: false };
const signal = () => new AbortController().signal;
const dispatch = vi.fn();
beforeEach(() => { transport.mockReset(); dispatch.mockReset(); vi.stubGlobal("window", { dispatchEvent: dispatch }); });
afterEach(() => vi.unstubAllGlobals());

describe("native source selection protocol", () => {
  it.each([null, {}, { hits: [], notices: ["failed"], status: {} }, { enabled: {} },
    { enabled: { ...enabled, tasks: "true" } }, { enabled: { ...enabled, unknown: false } },
    { enabled, revision: 42 }, { enabled, error: [] }])("rejects malformed responses without reporting a successful save: %j", async response => {
    transport.mockResolvedValue(response);
    await expect(readSearchSourceSelection("/repo", signal())).rejects.toThrow("Invalid search source selection response");
    await expect(setSearchSourceSelection("/repo", "tasks", true, signal())).rejects.toThrow("Invalid search source selection response");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps failed reads fail-closed and rejects failed writes without emitting a change", async () => {
    transport.mockResolvedValue({ enabled, error: "Search source policy busy; retry after the other writer finishes" });
    const policy = await readSearchSourceSelection("/repo", signal());
    expect(Object.values(policy.enabled).some(Boolean)).toBe(false);
    expect(policy.error).toContain("busy");
    await expect(setSearchSourceSelection("/repo", "tasks", true, signal())).rejects.toThrow("busy");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("emits one workspace-scoped notification only after a valid successful save", async () => {
    const policy = { enabled: { ...enabled, tasks: true }, revision: "saved-revision" };
    transport.mockResolvedValue(policy);
    expect(await setSearchSourceSelection("/repo", "tasks", true, signal())).toEqual(policy);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = dispatch.mock.calls[0]![0] as CustomEvent;
    expect(event.type).toBe(SEARCH_SOURCE_SELECTION_CHANGED);
    expect(event.detail).toEqual({ workspace: "/repo", global: false });
  });

  it("announces Settings changes to all workspaces", async () => {
    transport.mockResolvedValue({ enabled: { ...enabled, settings: false } });
    await setSearchSourceSelection("/repo", "settings", false, signal());
    expect(dispatch.mock.calls[0]![0].detail).toEqual({ workspace: "/repo", global: true });
  });

  it("does not announce a late save response after caller cancellation", async () => {
    const owner = new AbortController();
    transport.mockImplementation(async () => { owner.abort(); return { enabled }; });
    await expect(setSearchSourceSelection("/repo", "tasks", true, owner.signal)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
