import { describe, expect, it, vi } from "vitest";
import { createDesktopProjectActionServices } from "./desktop-project-action-services";

const actions = vi.hoisted(() => ({ actionId: null, runTaskFromAgent: vi.fn() }));
vi.mock("./project-actions.svelte", () => ({ createProjectActions: () => actions }));

function fixture() {
  let workspace = "/project";
  let client = {};
  const task = { id: "saved-task", title: "Updated by agent" };
  const tasks = { saving: false, loading: false, loadFailed: false,
    document: { version: 1, tasks: [] as unknown[] },
    load: vi.fn(async () => { tasks.document.tasks = [task]; }),
  };
  const services = createDesktopProjectActionServices({
    client: () => client, workspace: () => workspace, canUseSession: () => true,
    sessions: { runtime: {}, catalog: {} }, transitions: { sessionTabs: {} }, project: { tasks },
  } as any);
  actions.runTaskFromAgent.mockReset().mockResolvedValue({ sessionId: "child", outcome: "started" });
  const request = { requestId: "r1", cwd: "/project", taskId: task.id, sourceSessionId: "parent" };
  return { services, tasks, task, request, setWorkspace: (value: string) => { workspace = value; },
    replaceClient: () => { client = {}; } };
}

describe("agent Tasks Run boundary", () => {
  it("reloads the saved task instead of relying on a stale sidebar row", async () => {
    const { services, tasks, task, request } = fixture();
    const signal = new AbortController().signal;
    await expect(services.runTaskFromAgent(request, signal)).resolves.toEqual({ sessionId: "child", outcome: "started" });
    expect(tasks.load).toHaveBeenCalledWith("/project");
    expect(actions.runTaskFromAgent).toHaveBeenCalledWith(task, signal);
  });

  it.each(["workspace", "client", "abort", "failed read", "deleted task"])("rejects stale preparation after %s", async (reason) => {
    const harness = fixture();
    const controller = new AbortController();
    harness.tasks.load.mockImplementation(async () => {
      if (reason === "workspace") harness.setWorkspace("/elsewhere");
      if (reason === "client") harness.replaceClient();
      if (reason === "abort") controller.abort();
      if (reason === "failed read") harness.tasks.loadFailed = true;
    });
    await expect(harness.services.runTaskFromAgent(harness.request, controller.signal)).rejects.toThrow();
    expect(actions.runTaskFromAgent).not.toHaveBeenCalled();
  });

  it("rejects foreign-workspace and overlapping store loads before doing any work", async () => {
    const { services, tasks, request } = fixture();
    const signal = new AbortController().signal;
    await expect(services.runTaskFromAgent({ ...request, cwd: "/elsewhere" }, signal)).rejects.toThrow("busy");
    tasks.loading = true;
    await expect(services.runTaskFromAgent(request, signal)).rejects.toThrow("busy");
    expect(tasks.load).not.toHaveBeenCalled();
  });
});
