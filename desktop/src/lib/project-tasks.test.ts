import { describe, expect, it } from "vitest";
import {
  buildTaskPrompt,
  filterProjectTasks,
  normalizeProjectTaskLink,
  possibleTaskParents,
  taskHierarchyHoverRelation,
  moveProjectTask,
  parseTaskDocument,
  projectTaskDisplayLabel,
  projectTaskFromComposerDraft,
  projectTaskPromptDraft,
  taskStatusLabel,
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

  it("accepts failed without changing the document version", () => {
    const failed = { ...task, status: "failed" as const };
    expect(parseTaskDocument({ version: 1, tasks: [failed] }).tasks).toEqual([failed]);
    expect(taskStatusLabel("failed")).toBe("Failed");
    expect(filterProjectTasks([task, failed], { type: "all", status: "failed", priority: "all" })).toEqual([failed]);
  });

  it("accepts an untitled task with content and rejects a completely empty task", () => {
    const untitled = { ...task, title: "", description: "Captured from the composer." };
    expect(parseTaskDocument({ version: 1, tasks: [untitled] })).toEqual({ version: 1, tasks: [untitled] });
    expect(() => parseTaskDocument({ version: 1, tasks: [{ ...task, title: "", description: "   " }] }))
      .toThrow("Expected a title or description");
  });

  it("rejects unsupported versions, invalid enums, and duplicate ids", () => {
    expect(() => parseTaskDocument({ version: 2, tasks: [] })).toThrow("Invalid SQLite task view");
    expect(() => parseTaskDocument({ version: 1, tasks: [{ ...task, type: "chore" }] })).toThrow();
    expect(() => parseTaskDocument({ version: 1, tasks: [task, task] })).toThrow("Duplicate task id");
  });

  it("stores optional epic, parent, related task and model fields without migrating existing rows", () => {
    const epic = { ...task, epic: true };
    const child = { ...task, id: "child", parentId: "task-1", relatedTaskIds: ["peer"], modelRef: "provider/agent-model:high" };
    const peer = { ...task, id: "peer" };
    expect(parseTaskDocument({ version: 1, tasks: [epic, child, peer] }).tasks[1]).toEqual(child);
    expect(() => parseTaskDocument({ version: 1, tasks: [epic, { ...child, parentId: "missing" }, peer] })).toThrow("Unknown parent task");
    expect(() => parseTaskDocument({ version: 1, tasks: [epic, { ...child, parentId: "child" }, peer] })).toThrow("cycle");
    expect(() => parseTaskDocument({ version: 1, tasks: [epic, { ...child, epic: true }, peer] })).toThrow("top-level");
    expect(() => parseTaskDocument({ version: 1, tasks: [epic, { ...child, relatedTaskIds: ["missing"] }, peer] })).toThrow("Related tasks");
    expect(() => parseTaskDocument({ version: 1, tasks: [epic, { ...child, relatedTaskIds: ["peer", "peer"] }, peer] })).toThrow("Related tasks");
    expect(() => parseTaskDocument({ version: 1, tasks: [epic, { ...child, modelRef: "no-provider" }, peer] })).toThrow("provider/model");
  });

  it("limits selectable parent tasks to non-descendants and distinguishes parent/sibling hover", () => {
    const epic = { ...task, id: "epic", epic: true };
    const sibling = { ...task, id: "sibling", parentId: "epic" };
    const child = { ...task, id: "child", parentId: "epic" };
    const grandchild = { ...task, id: "grandchild", parentId: "child" };
    const unrelated = { ...task, id: "unrelated" };
    const tasks = [epic, child, sibling, grandchild, unrelated];
    expect(possibleTaskParents(tasks, "child").map((item) => item.id)).toEqual(["epic", "sibling", "unrelated"]);
    expect(taskHierarchyHoverRelation(epic, "child", tasks)).toBe("parent");
    expect(taskHierarchyHoverRelation(sibling, "child", tasks)).toBe("sibling");
    expect(taskHierarchyHoverRelation(child, "child", tasks)).toBeNull();
    expect(taskHierarchyHoverRelation(unrelated, "child", tasks)).toBeNull();
  });

  it("accepts project-relative artifacts or HTTP links without accepting paths outside the project", () => {
    expect(normalizeProjectTaskLink("  docs/specs/task.md  ")).toBe("docs/specs/task.md");
    expect(normalizeProjectTaskLink(".pi\\artifacts\\task\\report.txt")).toBe(".pi/artifacts/task/report.txt");
    expect(normalizeProjectTaskLink("https://example.org/task")).toBe("https://example.org/task");
    for (const input of ["/etc/passwd", "../secret", ".pi/../../secret", "file:///tmp/secret", "javascript:alert(1)", "~/private", "", "docs//oops.md"]) {
      expect(normalizeProjectTaskLink(input)).toBeUndefined();
    }
  });
});

describe("task list helpers", () => {
  it("builds an execution prompt with the optional description", () => {
    expect(buildTaskPrompt(task)).toContain("Type: Bug");
    expect(buildTaskPrompt(task)).not.toContain("Priority:");
    expect(buildTaskPrompt(task)).toContain("Description:\nKeep the active workspace selected.");
  });

  it.each(["bug", "feature", "improvement", "idea"] as const)("authorizes final outcomes only for the launched %s task", (type) => {
    const prompt = buildTaskPrompt({ ...task, type });
    expect(prompt).toContain("only this task's final status without another confirmation");
    expect(prompt).toContain('op: update and id: "task-1"');
    expect(prompt).toContain("status: done after successful completion and verification");
    expect(prompt).toContain("status: failed if you could not complete the task");
    expect(prompt).toContain("Do not mark a transient error as failed while still retrying");
    expect(prompt).toContain("Other task status changes still require explicit user confirmation");
    expect(prompt).toContain("do not claim it was saved or create a replacement task");
    if (type === "idea") expect(prompt).toContain("Do not change code without agreement");
  });

  it("retains failed tasks when moving another card and supports failed as a drop target", () => {
    const failed = { ...task, id: "failed-task", status: "failed" as const };
    const timestamp = "2026-09-08T20:00:00.000Z";
    expect(moveProjectTask([task, failed], task.id, "done", null, "after", timestamp)).toEqual([
      { ...task, status: "done", updatedAt: timestamp }, failed,
    ]);
    expect(moveProjectTask([task, failed], task.id, "failed", failed.id, "after", timestamp)).toEqual([
      failed, { ...task, status: "failed", updatedAt: timestamp },
    ]);
  });

  it("never turns a legacy marker into an attached file; SQLite is authoritative", () => {
    const withAttachment = {
      ...task,
      description: `Review the screenshot\n\n${attachmentMarker("/tmp/task-shot.png")}`,
    };
    const draft = projectTaskPromptDraft(withAttachment);

    expect(draft.text).toContain("Description:\nReview the screenshot");
    expect(draft.text).toContain("Pix attachment");
    expect(draft.attachments).toEqual([]);
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
    expect(created?.description).not.toContain(attachmentMarker("/tmp/composer-shot.png"));
    expect(projectTaskDisplayLabel(created!)).toBe("Investigate this behavior");
    expect(projectTaskPromptDraft(created!).text).not.toContain("Task:");
    expect(projectTaskPromptDraft(created!).attachments).toEqual([]);
    expect(projectTaskFromComposerDraft("", [attachment], "attachment-only", "2026-09-10T18:00:00.000Z")?.description)
      .toEqual("Attachment: composer-shot.png");
  });

  it("filters without changing source order", () => {
    const feature = { ...task, id: "task-2", type: "feature" as const, priority: "low" as const };
    const tasks = [task, feature];
    expect(filterProjectTasks(tasks, { type: "feature", status: "all", priority: "low" }))
      .toEqual([feature]);
    expect(tasks).toEqual([task, feature]);
  });

  it("combines status and priority independently of type filtering, including ideas", () => {
    const idea = { ...task, id: "idea", type: "idea" as const, status: "backlog" as const, priority: "urgent" as const };
    const done = { ...task, id: "done", status: "done" as const, priority: "urgent" as const };
    const tasks = [idea, task, done];
    expect(filterProjectTasks(tasks, { type: "all", status: "backlog", priority: "urgent" })).toEqual([idea]);
    expect(filterProjectTasks(tasks, { type: "all", status: "all", priority: "urgent" })).toEqual([idea, done]);
    expect(filterProjectTasks(tasks, { type: "all", status: "todo", priority: "urgent" })).toEqual([]);
    expect(tasks.map((item) => item.id)).toEqual(["idea", "task-1", "done"]);
  });

  it("moves an idea into an empty status group without losing type, links, priority, or session", () => {
    const source = { ...task, type: "idea" as const, links: ["docs/idea.md"], sessionId: "session-1" };
    const moved = moveProjectTask([source], source.id, "done", null, "after", "2026-09-08T20:00:00.000Z");
    expect(moved).toEqual([{ ...source, status: "done", updatedAt: "2026-09-08T20:00:00.000Z" }]);
    expect(source.status).toBe("todo");
  });

  it("moves tasks between status groups while preserving type and the requested position", () => {
    const bug2 = { ...task, id: "bug-2", title: "Second bug" };
    const feature = { ...task, id: "feature-1", type: "feature" as const, status: "backlog" as const, title: "Feature" };
    const moved = moveProjectTask(
      [task, bug2, feature],
      feature.id,
      "todo",
      bug2.id,
      "before",
      "2026-09-08T20:00:00.000Z",
    );
    expect(moved?.map((item: ProjectTask) => [item.id, item.type])).toEqual([
      [task.id, "bug"],
      [feature.id, "feature"],
      [bug2.id, "bug"],
    ]);
    expect(moved?.[1]?.updatedAt).toBe("2026-09-08T20:00:00.000Z");
    expect(moved?.[1]?.status).toBe("todo");
    expect(moved?.[0]).toBe(task);
    expect(moved?.[2]).toBe(bug2);
  });

  it("can append a task into an empty status group", () => {
    const moved = moveProjectTask(
      [task],
      task.id,
      "in-progress",
      null,
      "after",
      "2026-09-08T20:00:00.000Z",
    );
    expect(moved?.[0]).toEqual({ ...task, status: "in-progress", updatedAt: "2026-09-08T20:00:00.000Z" });
  });

  it("reorders within a status group without touching status, timestamps, or other fields", () => {
    const other = { ...task, id: "other", type: "feature" as const };
    const moved = moveProjectTask([task, other], task.id, "todo", other.id, "after", "2026-09-08T20:00:00.000Z");
    expect(moved).toEqual([other, task]);
    expect(moved?.[1]).toBe(task);
  });

  it("returns undefined for a self-drop, unchanged order, missing task, or wrong-status target", () => {
    expect(moveProjectTask([task], task.id, "done", task.id, "before", "later")).toBeUndefined();
    expect(moveProjectTask([task], task.id, "todo", null, "after", "later")).toBeUndefined();
    expect(moveProjectTask([task], "missing", "done", null, "after", "later")).toBeUndefined();
    const other = { ...task, id: "other" };
    expect(moveProjectTask([task, other], task.id, "done", other.id, "before", "later")).toBeUndefined();
  });

  it("normalizes group order without changing the order of other tasks within groups", () => {
    const backlog = { ...task, id: "backlog", status: "backlog" as const };
    const done = { ...task, id: "done", status: "done" as const };
    const progress = { ...task, id: "progress", status: "in-progress" as const };
    const todo = { ...task, id: "todo" };
    const moved = moveProjectTask([backlog, done, task, progress, todo], task.id, "todo", todo.id, "after", "later");
    expect(moved).toEqual([progress, todo, task, backlog, done]);
  });
});
