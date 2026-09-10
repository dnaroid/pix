import { describe, expect, it } from "vitest";
import {
  buildTaskPrompt,
  filterProjectTasks,
  moveProjectTask,
  parseTaskDocument,
  projectTaskDisplayLabel,
  projectTaskFromComposerDraft,
  projectTaskPromptDraft,
  type ProjectTask,
} from "./project-tasks";
import { attachmentFromFile, attachmentMarker } from "./attachments";

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

  it("accepts an untitled task with content and rejects a completely empty task", () => {
    const untitled = { ...task, title: "", description: "Captured from the composer." };
    expect(parseTaskDocument({ version: 1, tasks: [untitled] })).toEqual({ version: 1, tasks: [untitled] });
    expect(() => parseTaskDocument({ version: 1, tasks: [{ ...task, title: "", description: "   " }] }))
      .toThrow("Expected a title or description");
  });

  it("rejects unsupported versions, invalid enums, and duplicate ids", () => {
    expect(() => parseTaskDocument({ version: 2, tasks: [] })).toThrow("Invalid .pi/tasks.jsonc");
    expect(() => parseTaskDocument({ version: 1, tasks: [{ ...task, type: "chore" }] })).toThrow();
    expect(() => parseTaskDocument({ version: 1, tasks: [task, task] })).toThrow("Duplicate task id");
  });
});

describe("task list helpers", () => {
  it("builds an execution prompt with the optional description", () => {
    expect(buildTaskPrompt(task)).toContain("Type: Bug");
    expect(buildTaskPrompt(task)).not.toContain("Priority:");
    expect(buildTaskPrompt(task)).toContain("Description:\nKeep the active workspace selected.");
  });

  it("separates persisted task attachments from prompt text", () => {
    const withAttachment = {
      ...task,
      description: `Review the screenshot\n\n${attachmentMarker("/tmp/task-shot.png")}`,
    };
    const draft = projectTaskPromptDraft(withAttachment);

    expect(draft.text).toContain("Description:\nReview the screenshot");
    expect(draft.text).not.toContain("Pix attachment");
    expect(draft.attachments).toEqual([
      expect.objectContaining({ name: "task-shot.png", kind: "image", path: "/tmp/task-shot.png" }),
    ]);
  });

  it("creates an untitled feature task from composer text and attachments", () => {
    const attachment = attachmentFromFile(
      { path: "/tmp/composer-shot.png", name: "composer-shot.png", size: 12 },
      "attachment-1",
    );
    const created = projectTaskFromComposerDraft(
      "Investigate this behavior",
      [attachment],
      "task-from-composer",
      "2026-09-10T18:00:00.000Z",
    );

    expect(created).toEqual(expect.objectContaining({
      id: "task-from-composer",
      title: "",
      type: "feature",
      status: "todo",
      priority: "medium",
    }));
    expect(created?.description).toContain("Investigate this behavior");
    expect(created?.description).toContain(attachmentMarker("/tmp/composer-shot.png"));
    expect(projectTaskDisplayLabel(created!)).toBe("Investigate this behavior");
    expect(projectTaskPromptDraft(created!).text).not.toContain("Task:");
    expect(projectTaskPromptDraft(created!).attachments).toEqual([
      expect.objectContaining({ path: "/tmp/composer-shot.png" }),
    ]);
  });

  it("filters without changing source order", () => {
    const feature = { ...task, id: "task-2", type: "feature" as const, priority: "low" as const };
    const tasks = [task, feature];
    expect(filterProjectTasks(tasks, { type: "feature", status: "all", priority: "low" }))
      .toEqual([feature]);
    expect(tasks).toEqual([task, feature]);
  });

  it("moves tasks between type groups while preserving the requested position", () => {
    const bug2 = { ...task, id: "bug-2", title: "Second bug" };
    const feature = { ...task, id: "feature-1", type: "feature" as const, title: "Feature" };
    const moved = moveProjectTask(
      [task, bug2, feature],
      feature.id,
      "bug",
      bug2.id,
      "before",
      "2026-09-08T20:00:00.000Z",
    );
    expect(moved?.map((item: ProjectTask) => [item.id, item.type])).toEqual([
      [task.id, "bug"],
      [feature.id, "bug"],
      [bug2.id, "bug"],
    ]);
    expect(moved?.[1]?.updatedAt).toBe("2026-09-08T20:00:00.000Z");
  });

  it("can append a task into an empty type group", () => {
    const moved = moveProjectTask(
      [task],
      task.id,
      "improvement",
      null,
      "after",
      "2026-09-08T20:00:00.000Z",
    );
    expect(moved?.[0]?.type).toBe("improvement");
  });
});
