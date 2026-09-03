import { describe, expect, it } from "vitest";
import {
  buildTaskPrompt,
  filterProjectTasks,
  parseTaskDocument,
  type ProjectTask,
} from "./project-tasks";

const task: ProjectTask = {
  id: "task-1",
  title: "Repair reconnect",
  description: "Keep the active workspace selected.",
  type: "bug",
  status: "todo",
  priority: "high",
  createdAt: "2026-09-03T12:00:00.000Z",
  updatedAt: "2026-09-03T12:00:00.000Z",
};

describe("project task documents", () => {
  it("accepts a valid versioned document", () => {
    expect(parseTaskDocument({ version: 1, tasks: [task] })).toEqual({ version: 1, tasks: [task] });
  });

  it("rejects unsupported versions, invalid enums, and duplicate ids", () => {
    expect(() => parseTaskDocument({ version: 2, tasks: [] })).toThrow("Invalid .pi/tasks.json");
    expect(() => parseTaskDocument({ version: 1, tasks: [{ ...task, type: "chore" }] })).toThrow();
    expect(() => parseTaskDocument({ version: 1, tasks: [task, task] })).toThrow("Duplicate task id");
  });
});

describe("task list helpers", () => {
  it("builds an execution prompt with the optional description", () => {
    expect(buildTaskPrompt(task)).toContain("Type: Bug");
    expect(buildTaskPrompt(task)).toContain("Priority: High");
    expect(buildTaskPrompt(task)).toContain("Description:\nKeep the active workspace selected.");
  });

  it("filters without changing source order", () => {
    const feature = { ...task, id: "task-2", type: "feature" as const, priority: "low" as const };
    const tasks = [task, feature];
    expect(filterProjectTasks(tasks, { type: "feature", status: "all", priority: "low" }))
      .toEqual([feature]);
    expect(tasks).toEqual([task, feature]);
  });
});
