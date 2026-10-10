import { describe, expect, it, vi } from "vitest";
import type { TaskTypeClassifyResponse } from "../../../acp/src/tasks/type-classification-contract";
import { TaskQuickAddController, type QuickTaskDraft, type TaskTypeClient } from "./task-quick-add-controller";
import { quickTaskDraft } from "./quick-task";

describe("Quick Add task creation", () => {
  it("preserves entered/dictated text without model rewriting, including long and multiline input", () => {
    expect(quickTaskDraft("  Fix failing CI  ", "bug")).toEqual({ title: "Fix failing CI", type: "bug", status: "todo" });
    expect(quickTaskDraft("first line\nsecond line", "idea")).toEqual({
      title: "first line", description: "first line\nsecond line", type: "idea", status: "todo",
    });
    const long = "a".repeat(201);
    expect(quickTaskDraft(long, "improvement")).toEqual({
      title: "a".repeat(200), description: long, type: "improvement", status: "todo",
    });
    expect(quickTaskDraft("  ", "feature")).toBeUndefined();
  });

  it("routes one explicit text submission to Jev and one existing create operation", async () => {
    const classifyTaskType = vi.fn(async () => ({ type: "bug" as const, fallback: false }));
    const create = vi.fn(async (_draft: QuickTaskDraft) => true);
    const result = await new TaskQuickAddController().submit("  App crashes on start ", "/project", { classifyTaskType }, create);
    expect(result).toEqual({ status: "created", type: "bug", fallback: false });
    expect(classifyTaskType).toHaveBeenCalledExactlyOnceWith({ cwd: "/project", text: "App crashes on start" }, expect.any(AbortSignal));
    expect(create).toHaveBeenCalledExactlyOnceWith({ title: "App crashes on start", type: "bug", status: "todo" });
  });

  it("creates as Feature without a client, on provider failure, and on invalid decisions", async () => {
    const create = vi.fn(async (_draft: QuickTaskDraft) => true);
    const controller = new TaskQuickAddController();
    expect(await controller.submit("Add search", "/project", null, create))
      .toEqual({ status: "created", type: "feature", fallback: true });
    expect(await controller.submit("Add search", "/project", { classifyTaskType: async () => { throw new Error("secret credential"); } }, create))
      .toEqual({ status: "created", type: "feature", fallback: true });
    expect(await controller.submit("Add search", "/project", { classifyTaskType: async () => ({ type: "invalid" as "bug", fallback: false }) }, create))
      .toEqual({ status: "created", type: "feature", fallback: true });
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls.every(([draft]) => draft.type === "feature")).toBe(true);
  });

  it("does not erase text on rejected storage saves; skips empty or oversized queries", async () => {
    const create = vi.fn(async () => false);
    const controller = new TaskQuickAddController();
    expect(await controller.submit("Something", "/project", null, create)).toEqual({ status: "failed" });
    expect(await controller.submit(" ", "/project", null, create)).toEqual({ status: "empty" });
    expect(await controller.submit("a".repeat(2049), "/project", null, create)).toEqual({ status: "empty" });
    expect(await controller.submit("Something", "", null, create)).toEqual({ status: "empty" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not save stale classifications after cancellation and allows a new generation", async () => {
    let finish!: (result: { type: "idea"; fallback: false }) => void;
    const client: TaskTypeClient = { classifyTaskType: vi.fn(() => new Promise<TaskTypeClassifyResponse>(resolve => { finish = resolve; })) };
    const create = vi.fn(async () => true);
    const controller = new TaskQuickAddController();
    const pending = controller.submit("Brainstorm new editor", "/old", client, create);
    expect(await controller.submit("duplicate", "/old", client, create)).toEqual({ status: "busy" });
    controller.cancel();
    finish({ type: "idea", fallback: false });
    expect(await pending).toEqual({ status: "cancelled" });
    expect(create).not.toHaveBeenCalled();
    expect(await controller.submit("Repair build", "/new", null, create))
      .toEqual({ status: "created", type: "feature", fallback: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("settles cancellation even if the ACP provider never finishes", async () => {
    const client: TaskTypeClient = { classifyTaskType: () => new Promise(() => {}) };
    const create = vi.fn(async () => true);
    const controller = new TaskQuickAddController();
    const pending = controller.submit("Cannot complete Jev", "/project", client, create);
    controller.cancel();
    expect(await pending).toEqual({ status: "cancelled" });
    expect(create).not.toHaveBeenCalled();
    expect(controller.busy).toBe(false);
  });

  it("guards task creation when the project changes during classification", async () => {
    let finish!: (result: { type: "improvement"; fallback: false }) => void;
    const client: TaskTypeClient = { classifyTaskType: () => new Promise(resolve => { finish = resolve; }) };
    let workspace = "/old";
    const create = vi.fn(async () => true);
    const pending = new TaskQuickAddController().submit("Improve scrolling", workspace, client, create, () => workspace === "/old");
    workspace = "/new";
    finish({ type: "improvement", fallback: false });
    expect(await pending).toEqual({ status: "cancelled" });
    expect(create).not.toHaveBeenCalled();
  });
});
