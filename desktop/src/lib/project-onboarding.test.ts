import { describe, expect, it, vi } from "vitest";
import { isOnboardingResource, projectOnboardingPlan, type OnboardingResource, type ProjectOnboardingActions } from "./project-onboarding";

const agent: OnboardingResource = {
  id: "agent:review", type: "agent", name: "review", status: "not-installed",
  statusLabel: "Not installed", icon: "agent",
  local: false, remote: true, actions: ["install"], publicationScope: "global",
};
const choices = {
  git: true, wiki: true, knowledge: true, autoCheck: true, resources: [agent],
  icon: { kind: "generate", prompt: "A book" } as const,
};

describe("project setup", () => {
  it("stops at the failed step and resumes without replaying completed steps", async () => {
    const calls: string[] = [];
    const step = (name: string) => vi.fn(async () => { calls.push(name); });
    const actions = {
      git: step("git"), wiki: step("wiki"), knowledge: step("knowledge"), autoCheck: step("autoCheck"),
      install: step("install"), icon: step("icon"),
    } satisfies ProjectOnboardingActions;
    actions.knowledge.mockRejectedValueOnce(new Error("policy"));
    const plan = projectOnboardingPlan(choices, actions);
    const signal = new AbortController().signal;
    await expect(plan.run(signal, vi.fn())).rejects.toThrow("policy");
    expect(calls).toEqual(["git", "wiki"]);
    await plan.run(signal, vi.fn());
    expect(calls).toEqual(["git", "wiki", "knowledge", "autoCheck", "install", "icon"]);
    expect(actions.install).toHaveBeenCalledWith(agent, signal);
  });

  it("omits unchecked steps and never starts background checks without both dependencies", async () => {
    const invoke = vi.fn(async () => {});
    const plan = projectOnboardingPlan({ ...choices, wiki: false, git: false, resources: [], icon: undefined }, {
      git: invoke, wiki: invoke, knowledge: invoke, autoCheck: invoke, install: invoke, icon: invoke,
    });
    const progress = vi.fn();
    await plan.run(new AbortController().signal, progress);
    expect(invoke).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith("Enable Knowledge indexing");
  });

  it("does not submit twice or run the next step after workspace teardown", async () => {
    let finish!: () => void;
    const git = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const wiki = vi.fn(async () => {});
    const plan = projectOnboardingPlan(choices, { git, wiki, knowledge: wiki, autoCheck: wiki, install: wiki, icon: wiki });
    const controller = new AbortController();
    const run = plan.run(controller.signal, vi.fn());
    await plan.run(controller.signal, vi.fn());
    controller.abort();
    finish();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(git).toHaveBeenCalledOnce();
    expect(wiki).not.toHaveBeenCalled();
  });

  it("only offers installable global agents and skills", () => {
    expect(isOnboardingResource(agent)).toBe(true);
    expect(isOnboardingResource({ ...agent, type: "skill" })).toBe(true);
    expect(isOnboardingResource({ ...agent, publicationScope: "project" })).toBe(false);
    expect(isOnboardingResource({ ...agent, actions: [] })).toBe(false);
    expect(isOnboardingResource({ ...agent, remote: false })).toBe(false);
  });
});
