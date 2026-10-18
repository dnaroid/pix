import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createProjectPlanActions } from "./project-plan-actions.svelte";
import { buildProjectPlanPrompt, buildProjectPlanResumePrompt } from "./project-plan-prompt";

const path = ".pi/plans/releases/rollout.md";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  const client = { newSession: vi.fn().mockResolvedValue({ sessionId: "new" }), closeSession: vi.fn().mockResolvedValue(undefined) };
  let workspace = "/project";
  let sessionId: string | null = "old";
  const options: Parameters<typeof createProjectPlanActions>[0] = {
    client: () => client as unknown as AcpClient, workspace: () => workspace,
    canUseSession: () => true, sessionMutationRunning: () => false, planAvailable: () => true,
    activeSessionId: () => sessionId, closeProjectSelector: vi.fn(), closeSessionSelector: vi.fn(),
    setOperationRunning: vi.fn(), setErrorMessage: vi.fn(), ensureRuntime: vi.fn().mockResolvedValue(undefined),
    runtimeReady: () => true, forgetRuntime: vi.fn(),
    activateSession: vi.fn((id) => { sessionId = id; }),
    appendUserMessage: vi.fn().mockReturnValue("message"), scrollToLatest: vi.fn().mockResolvedValue(undefined),
    runPrompt: vi.fn().mockResolvedValue(undefined), refreshSessions: vi.fn(), reportError: vi.fn(),
    recordPlanLaunch: vi.fn(), settlePlanLaunch: vi.fn(),
  };
  const actions = createProjectPlanActions(options, () => false);
  return { client, options, actions, changeWorkspace: (next: string) => { workspace = next; }, navigate: () => { sessionId = "other"; } };
}

describe("plan launch in a new session", () => {
  it("opens a fresh session and sends an exact saved-plan reference without altering a task or composer", async () => {
    const { client, options, actions } = fixture();
    await actions.runPlan(path);
    expect(client.newSession).toHaveBeenCalledExactlyOnceWith("/project");
    expect(options.activateSession).toHaveBeenCalledWith("new", "/project", false);
    expect(options.ensureRuntime).toHaveBeenCalledWith(client, "new", "/project");
    const prompt = buildProjectPlanPrompt(path);
    expect(prompt).toContain(JSON.stringify(path));
    expect(prompt).toContain("Read the saved file first");
    expect(options.appendUserMessage).toHaveBeenCalledWith("new", prompt, []);
    expect(options.runPrompt).toHaveBeenCalledWith(client, "new", [{ type: "text", text: prompt }], [], "message");
    expect(options.setOperationRunning).toHaveBeenLastCalledWith(false);
    expect(actions.actionId).toBeNull();
  });

  it.each(["offline", "opening", "mutation", "missing", "invalid", "busy"])("does not launch when %s", async (reason) => {
    const { client, options } = fixture();
    if (reason === "offline") options.canUseSession = () => false;
    if (reason === "opening") options.workspaceOpening = () => true;
    if (reason === "mutation") options.sessionMutationRunning = () => true;
    if (reason === "missing") options.planAvailable = () => false;
    const actions = createProjectPlanActions(options, () => reason === "busy");
    await actions.runPlan(reason === "invalid" ? "README.md" : path);
    expect(client.newSession).not.toHaveBeenCalled();
  });

  it("ignores repeated clicks while creating the session", async () => {
    const { actions, client } = fixture();
    const created = deferred<{ sessionId: string }>();
    vi.mocked(client.newSession).mockReturnValue(created.promise);
    const first = actions.runPlan(path);
    expect(actions.actionId).toBe(`plan:${path}`);
    await actions.runPlan(path);
    created.resolve({ sessionId: "new" });
    await first;
    expect(client.newSession).toHaveBeenCalledOnce();
  });

  it.each(["workspace", "reset"])("closes a stale new session after %s invalidation", async (reason) => {
    const { actions, client, options, changeWorkspace } = fixture();
    const created = deferred<{ sessionId: string }>();
    vi.mocked(client.newSession).mockReturnValue(created.promise);
    const run = actions.runPlan(path);
    if (reason === "workspace") changeWorkspace("/other");
    else actions.reset();
    created.resolve({ sessionId: "late" });
    await run;
    expect(client.closeSession).toHaveBeenCalledWith("late");
    expect(options.forgetRuntime).toHaveBeenCalledWith("late");
    expect(options.activateSession).not.toHaveBeenCalled();
    expect(options.recordPlanLaunch).not.toHaveBeenCalled();
    expect(options.runPrompt).not.toHaveBeenCalled();
  });

  it("remembers the launched plan for the new session only", async () => {
    const { actions, options } = fixture();
    await actions.runPlan(path);
    expect(options.recordPlanLaunch).toHaveBeenCalledExactlyOnceWith("/project", "new", path);
  });

  it.each(["runtime", "scroll"])("does not send after navigating away during %s preparation", async (stage) => {
    const { actions, options, navigate } = fixture();
    if (stage === "runtime") options.ensureRuntime = async () => { navigate(); };
    else options.scrollToLatest = async () => { navigate(); };
    await actions.runPlan(path);
    expect(options.runPrompt).not.toHaveBeenCalled();
  });

  it("does not send the prompt when the plan is deleted during the launch", async () => {
    const { actions, options } = fixture();
    let available = true;
    options.planAvailable = () => available;
    options.ensureRuntime = async () => { available = false; };
    await actions.runPlan(path);
    expect(options.activateSession).toHaveBeenCalledWith("new", "/project", false);
    expect(options.appendUserMessage).not.toHaveBeenCalled();
    expect(options.runPrompt).not.toHaveBeenCalled();
    expect(options.setErrorMessage).toHaveBeenLastCalledWith(`Plan ${path} was removed before the run started.`);
    expect(options.setOperationRunning).toHaveBeenLastCalledWith(false);
    expect(actions.actionId).toBeNull();
  });

  it("does not let an old completion unlock a replacement launch after reset", async () => {
    const { actions, client } = fixture();
    const old = deferred<{ sessionId: string }>();
    const replacement = deferred<{ sessionId: string }>();
    client.newSession.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    const first = actions.runPlan(path);
    actions.reset();
    const second = actions.runPlan(path);
    old.resolve({ sessionId: "stale" });
    await first;
    expect(actions.actionId).toBe(`plan:${path}`);
    replacement.resolve({ sessionId: "new" });
    await second;
    expect(actions.actionId).toBeNull();
  });

  it("reports launch failures and releases busy state", async () => {
    const { actions, client, options } = fixture();
    const error = new Error("Cannot create session");
    client.newSession.mockRejectedValue(error);
    await actions.runPlan(path);
    expect(options.reportError).toHaveBeenCalledWith(error);
    expect(options.setOperationRunning).toHaveBeenLastCalledWith(false);
    expect(actions.actionId).toBeNull();
  });

  it("resumes with a continuation prompt that keeps the execution rules", async () => {
    const { actions, options } = fixture();
    await actions.resumePlan(path);
    const prompt = buildProjectPlanResumePrompt(path);
    expect(prompt).toContain("first unchecked item");
    expect(prompt).toContain(buildProjectPlanPrompt(path));
    expect(options.appendUserMessage).toHaveBeenCalledWith("new", prompt, []);
    expect(options.recordPlanLaunch).toHaveBeenCalledExactlyOnceWith("/project", "new", path);
  });

  it("leaves the outcome to the prompt lifecycle once the prompt was sent", async () => {
    const { actions, options } = fixture();
    await actions.runPlan(path);
    expect(options.settlePlanLaunch).not.toHaveBeenCalled();
  });

  it.each([
    ["removed", "failed"],
    ["navigated", "cancelled"],
    ["runtime failed", "failed"],
    ["runtime threw", "failed"],
  ] as const)("settles a recorded launch whose prompt never started (%s → %s)", async (reason, outcome) => {
    const { actions, options, navigate } = fixture();
    let available = true;
    options.planAvailable = () => available;
    if (reason === "removed") options.ensureRuntime = async () => { available = false; };
    if (reason === "navigated") options.ensureRuntime = async () => { navigate(); };
    if (reason === "runtime failed") options.runtimeReady = () => false;
    if (reason === "runtime threw") options.ensureRuntime = async () => { throw new Error("boom"); };
    await actions.runPlan(path);
    expect(options.runPrompt).not.toHaveBeenCalled();
    expect(options.settlePlanLaunch).toHaveBeenCalledExactlyOnceWith("new", outcome, "/project");
  });

  it("does not settle when the session was never recorded", async () => {
    const { actions, options, client } = fixture();
    client.newSession.mockRejectedValueOnce(new Error("offline"));
    await actions.runPlan(path);
    expect(options.recordPlanLaunch).not.toHaveBeenCalled();
    expect(options.settlePlanLaunch).not.toHaveBeenCalled();
  });
});
