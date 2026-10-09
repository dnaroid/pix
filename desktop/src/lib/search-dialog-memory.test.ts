import { describe, expect, it, vi } from "vitest";
import { SearchDialogMemory } from "./search-dialog-memory";
import { SearchDialogController, emptySearchDialogState } from "./search-dialog-controller";
import { pendingSearchNotice } from "./search-source-deadline";

describe("window-owned search memory", () => {
  it("does not preselect the first result on a fresh or new-workspace search", () => {
    const memory = new SearchDialogMemory();
    const client = {};
    expect(memory.restore("/one", client).active).toBe(-1);
    expect(memory.restore("/one", client).mode).toBe("auto");
    const draft = memory.restore("/one", client);
    draft.active = 2;
    memory.save("/one", client, draft);
    expect(memory.restore("/one", client).active).toBe(2);
    expect(memory.restore("/two", client).active).toBe(-1);
  });
  it("restores completed query, filters, results and selected row without searching", async () => {
    const memory = new SearchDialogMemory();
    const client = {};
    const draft = memory.restore("/project", client);
    draft.query = "renderer";
    draft.types = ["tasks"];
    draft.active = 1;
    draft.mode = "auto";
    draft.view.submitted = true;
    draft.view.result.results = [{ kind: "tasks", id: "tasks:1", taskId: "1", title: "Renderer", snippet: "", score: 1 }];
    memory.save("/project", client, draft);
    const restored = memory.restore("/project", client);
    expect(restored).toEqual(draft);
    const search = vi.fn();
    const publish = vi.fn();
    const controller = new SearchDialogController(search, async () => ({ enabled: false, keyAvailable: false, indexing: false }), publish, 1000, restored.view);
    controller.start();
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    expect(publish.mock.lastCall?.[0].result).toEqual(draft.view.result);
    expect(publish.mock.lastCall?.[0].submitted).toBe(true);
    expect(search).not.toHaveBeenCalled();
    controller.dispose();
    restored.types.push("commits");
    restored.view.result.results.splice(0);
    expect(memory.restore("/project", client)).toEqual(draft);
  });
  it("requires explicit resubmit after closing during a request and ignores late completion", async () => {
    const memory = new SearchDialogMemory();
    let view = emptySearchDialogState();
    let finish!: (value: typeof view.result) => void;
    const pending = new Promise<typeof view.result>(resolve => { finish = resolve; });
    const controller = new SearchDialogController(async () => pending, undefined, state => { view = state; });
    memory.resetFor("/project", null);
    const submitted = controller.submit("pending", ["commits"]);
    controller.dispose();
    memory.save("/project", null, { query: "pending", types: ["commits"], view, active: 0 });
    finish({ results: [], notices: ["late"], idxAvailable: false });
    await submitted;
    const restored = memory.restore("/project", null);
    expect(restored.query).toBe("pending");
    expect(restored.types).toEqual(["commits"]);
    expect(restored.view).toMatchObject({ busy: false, submitted: false });
    expect(restored.view.result.notices).toEqual([]);
  });
  it("retains partial hits on close but scrubs cancelled pending indicators", () => {
    const memory = new SearchDialogMemory(), client = {};
    const draft = memory.restore("/one", client);
    draft.view.submitted = true;
    draft.view.result.results = [{ kind: "tasks", id: "tasks:1", taskId: "1", title: "Renderer", snippet: "", score: 1 }];
    draft.view.result.pendingSources = ["Tasks"];
    draft.view.result.notices = [pendingSearchNotice("Tasks"), "A source failed"];
    memory.save("/one", client, draft);
    const restored = memory.restore("/one", client);
    expect(restored.view.result.results).toEqual(draft.view.result.results);
    expect(restored.view.result.pendingSources).toBeUndefined();
    expect(restored.view.result.notices).toEqual(["A source failed", expect.stringContaining("Press Search")]);
    expect(restored.view.submitted).toBe(true);
    expect(draft.view.result.pendingSources).toEqual(["Tasks"]);
  });

  it("does not restore an unfinished empty search as successfully completed", () => {
    const memory = new SearchDialogMemory(), client = {};
    const draft = memory.restore("/one", client);
    draft.view.submitted = true;
    draft.view.result.pendingSources = ["Tasks"];
    draft.view.result.notices = [pendingSearchNotice("Tasks")];
    memory.save("/one", client, draft);
    expect(memory.restore("/one", client).view).toMatchObject({ submitted: false, busy: false, result: { notices: [] } });
  });

  it("clears on workspace/client changes and rejects obsolete teardown saves", () => {
    const memory = new SearchDialogMemory();
    const client = {};
    const old = memory.restore("/first", client);
    old.query = "private";
    memory.save("/first", client, old);
    memory.resetFor("/second", client);
    memory.save("/first", client, old);
    expect(memory.restore("/second", client).query).toBe("");
    expect(memory.restore("/first", client).query).toBe("");
    memory.save("/first", client, old);
    expect(memory.restore("/first", {}).query).toBe("");
  });
});
