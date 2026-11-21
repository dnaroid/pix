import { describe, expect, it, vi } from "vitest";
import { createDesktopProjectActionServices } from "./desktop-project-action-services";
import type { ProjectTask } from "../lib/project-tasks";
import type { TaskRunRequest } from "../../../acp/src/acp/task-run-contract";
import { SUPERVISOR_WORKER_PREAMBLE, type SupervisorStartRequest } from "../../../acp/src/acp/supervisor-contract";

const actions = vi.hoisted(() => ({ actionId: null as string | null, runTaskFromAgent: vi.fn(), startFromAgent: vi.fn() }));
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("./project-actions.svelte", () => ({ createProjectActions: () => actions }));

function fixture() {
  let workspace = "/project";
  let client = {};
  const task = { id: "saved-task", title: "Updated by agent" } as ProjectTask;
  const configOptions = [{ id: "model", type: "select", currentValue: "provider/hidden", options: [
    { value: "provider/favorite", name: "Favorite", _meta: { "pix.thinkingLevels": ["off", "high"] } },
    { value: "provider/hidden", name: "Hidden" }, { value: "pix:auto", name: "Auto" },
  ] }];
  native.invoke.mockReset().mockResolvedValue({ content: '{"visibleModels":["provider/favorite","provider/unavailable"]}' });
  const tasks = { saving: false, loading: false, loadFailed: false,
    document: { version: 1, tasks: [] as unknown[] },
    load: vi.fn(async () => { tasks.document.tasks = [task]; }),
  };
  const state = { sessionId: "sup" as string | null };
  const draft = { active: false };
  const loadSession = vi.fn(async (_sessionId: string) => {});
  const reportError = vi.fn();
  const services = createDesktopProjectActionServices({
    client: () => client, workspace: () => workspace, canUseSession: () => true, state, reportError,
    sessions: { runtime: { getConfigOptions: () => configOptions }, catalog: {} },
    transitions: { sessionTabs: { loadSession }, draft }, project: { tasks },
  } as any);
  actions.runTaskFromAgent.mockReset().mockResolvedValue({ sessionId: "child", outcome: "started" });
  actions.startFromAgent.mockReset().mockResolvedValue("worker");
  actions.actionId = null;
  const request = { requestId: "r1", cwd: "/project", taskId: task.id, sourceSessionId: "parent" } satisfies TaskRunRequest;
  return { services, tasks, task, request, state, draft, loadSession, setWorkspace: (value: string) => { workspace = value; },
    replaceClient: () => { client = {}; } };
}

describe("agent Tasks Run boundary", () => {
  it("lists only available favorites with thinking levels without loading or launching tasks", async () => {
    const { services, tasks, request } = fixture();
    const modelsRequest: TaskRunRequest = { requestId: "m", sourceSessionId: request.sourceSessionId, cwd: request.cwd, op: "models" };
    const signal = new AbortController().signal;
    await expect(services.runTaskFromAgent(modelsRequest, signal)).resolves.toEqual({ models: [
      { modelRef: "provider/favorite", name: "Favorite", thinkingLevels: ["off", "high"] },
    ] });
    expect(tasks.load).not.toHaveBeenCalled();
    expect(actions.runTaskFromAgent).not.toHaveBeenCalled();
    native.invoke.mockResolvedValueOnce({ content: '{}' });
    const all = await services.runTaskFromAgent(modelsRequest, signal);
    expect("models" in all && all.models.map(model => model.modelRef)).toEqual(["provider/hidden", "provider/favorite"]);
    native.invoke.mockResolvedValueOnce({ content: '{"visibleModels":[]}' });
    await expect(services.runTaskFromAgent(modelsRequest, signal)).resolves.toEqual({ models: [] });
  });

  it("passes a validated favorite override without editing the saved assignment", async () => {
    const { services, task, request } = fixture();
    task.modelRef = "provider/saved:off";
    const signal = new AbortController().signal;
    await services.runTaskFromAgent({ ...request, modelRef: "provider/favorite:high" }, signal);
    expect(actions.runTaskFromAgent).toHaveBeenCalledWith(task, signal, "provider/favorite:high");
    expect(task.modelRef).toBe("provider/saved:off");
  });

  it.each(["provider/hidden", "provider/missing", "provider/favorite:max", "pix:auto", "invalid"])("rejects non-favorite or unsupported override %s before launching", async (modelRef) => {
    const { services, request } = fixture();
    await expect(services.runTaskFromAgent({ ...request, modelRef }, new AbortController().signal)).rejects.toThrow("favorite model");
    expect(actions.runTaskFromAgent).not.toHaveBeenCalled();
  });

  it("opens linked tasks without validating or changing their model", async () => {
    const { services, request, task } = fixture();
    task.sessionId = "linked";
    await services.runTaskFromAgent({ ...request, modelRef: "provider/hidden" }, new AbortController().signal);
    expect(native.invoke).not.toHaveBeenCalled();
    expect(actions.runTaskFromAgent).toHaveBeenCalledOnce();
  });

  it("fails closed if favorite preferences cannot be read", async () => {
    const { services, request } = fixture();
    native.invoke.mockRejectedValueOnce(new Error("Settings unavailable"));
    await expect(services.runTaskFromAgent({ ...request, modelRef: "provider/favorite" }, new AbortController().signal)).rejects.toThrow("Settings unavailable");
    expect(actions.runTaskFromAgent).not.toHaveBeenCalled();
  });

  it.each(["deleted", "linked"])("uses the latest task if it is %s while reading model preferences", async (change) => {
    const { services, tasks, request, task } = fixture();
    const linked = { ...task, sessionId: "existing-session" };
    native.invoke.mockImplementationOnce(async () => {
      tasks.document.tasks = change === "deleted" ? [] : [linked];
      return { content: '{}' };
    });
    const result = services.runTaskFromAgent({ ...request, modelRef: "provider/missing" }, new AbortController().signal);
    if (change === "deleted") {
      await expect(result).rejects.toThrow("Unknown project task id");
      expect(actions.runTaskFromAgent).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toEqual({ sessionId: "child", outcome: "started" });
      expect(actions.runTaskFromAgent).toHaveBeenCalledWith(linked, expect.any(AbortSignal), "provider/missing");
    }
  });

  it.each(["workspace", "client", "abort"])("rejects stale model selection after %s changes during config read", async (reason) => {
    const harness = fixture();
    const controller = new AbortController();
    native.invoke.mockImplementationOnce(async () => {
      if (reason === "workspace") harness.setWorkspace("/elsewhere");
      if (reason === "client") harness.replaceClient();
      if (reason === "abort") controller.abort();
      return { content: '{}' };
    });
    await expect(harness.services.runTaskFromAgent({ ...harness.request, modelRef: "provider/favorite" }, controller.signal)).rejects.toThrow("workspace changed");
    expect(actions.runTaskFromAgent).not.toHaveBeenCalled();
  });
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

describe("supervisor start boundary", () => {
  const prefix = `${SUPERVISOR_WORKER_PREAMBLE}\n\n`;
  const start = (item: SupervisorStartRequest["item"], extra: Partial<SupervisorStartRequest> = {}): SupervisorStartRequest =>
    ({ requestId: "s1", cwd: "/project", sourceSessionId: "sup", item, ...extra });

  it("launches plans and prompts with the worker rules and the requested model", async () => {
    const { services } = fixture();
    const signal = new AbortController().signal;
    await expect(services.startFromSupervisor(start({ kind: "plan", path: ".pi/plans/p.md" }, { modelRef: "p/m" }), signal))
      .resolves.toEqual({ sessionId: "worker" });
    expect(actions.startFromAgent).toHaveBeenCalledWith({ kind: "plan", path: ".pi/plans/p.md" }, signal, prefix, "p/m");
    await services.startFromSupervisor(start({ kind: "prompt", text: "fix it" }), signal);
    expect(actions.startFromAgent).toHaveBeenLastCalledWith({ kind: "prompt", text: "fix it" }, signal, prefix, undefined);
  });

  it("runs a fresh saved task with the worker rules and refuses one already linked to a session", async () => {
    const { services, tasks, task } = fixture();
    const signal = new AbortController().signal;
    await expect(services.startFromSupervisor(start({ kind: "task", taskId: task.id }), signal)).resolves.toEqual({ sessionId: "child" });
    expect(tasks.load).toHaveBeenCalledWith("/project");
    expect(actions.runTaskFromAgent).toHaveBeenCalledWith(task, signal, undefined, prefix);
    task.sessionId = "old";
    await expect(services.startFromSupervisor(start({ kind: "task", taskId: task.id }), signal)).rejects.toThrow("already has session old");
    await expect(services.startFromSupervisor(start({ kind: "task", taskId: "missing" }), signal)).rejects.toThrow("Unknown project task id");
    expect(actions.runTaskFromAgent).toHaveBeenCalledOnce();
  });

  it.each(["task", "prompt"] as const)("returns focus to the origin tab after a %s worker is dispatched", async (kind) => {
    const { services, state, task, loadSession } = fixture();
    const launched = kind === "task" ? "child" : "worker";
    const launch = kind === "task" ? actions.runTaskFromAgent : actions.startFromAgent;
    const result = kind === "task" ? { sessionId: launched, outcome: "started" } : launched;
    launch.mockImplementationOnce(async () => { state.sessionId = launched; return result; });
    const item: SupervisorStartRequest["item"] = kind === "task" ? { kind: "task", taskId: task.id } : { kind: "prompt", text: "x" };
    await expect(services.startFromSupervisor(start(item), new AbortController().signal)).resolves.toEqual({ sessionId: launched });
    expect(loadSession).toHaveBeenCalledExactlyOnceWith("sup");
  });

  it.each(["navigated", "draft origin", "workspace"])("keeps the current tab when the %s", async (reason) => {
    const harness = fixture();
    if (reason === "draft origin") harness.draft.active = true;
    actions.startFromAgent.mockImplementationOnce(async () => {
      // The worker tab was activated, then the user (or a project switch) moved on.
      harness.state.sessionId = reason === "navigated" ? "other" : "worker";
      if (reason === "workspace") harness.setWorkspace("/elsewhere");
      return "worker";
    });
    await harness.services.startFromSupervisor(start({ kind: "prompt", text: "x" }), new AbortController().signal);
    expect(harness.loadSession).not.toHaveBeenCalled();
  });

  it.each(["workspace", "busy", "aborted"])("refuses to launch when the window is %s", async (reason) => {
    const { services } = fixture();
    const controller = new AbortController();
    if (reason === "aborted") controller.abort();
    if (reason === "busy") actions.actionId = "other-task";
    const request = start({ kind: "prompt", text: "x" }, reason === "workspace" ? { cwd: "/elsewhere" } : {});
    await expect(services.startFromSupervisor(request, controller.signal)).rejects.toThrow("busy or showing another project");
    expect(actions.startFromAgent).not.toHaveBeenCalled();
  });
});
