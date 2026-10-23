import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import WorkspaceSidebarTaskDetails from "./WorkspaceSidebarTaskDetails.svelte";
import type { ProjectTask } from "../lib/project-tasks";

const task: ProjectTask = {
  id: "task", title: "Task", description: "First line\nSecond <script>unsafe</script>",
  type: "bug", status: "in-progress", priority: "urgent",
  createdAt: "2026-09-13T12:00:00.000Z", updatedAt: "2026-09-13T12:00:00.000Z",
};

describe("task card details", () => {
  it("shows full multiline description and task parameters as escaped text", () => {
    const html = render(WorkspaceSidebarTaskDetails, { props: { task, tasks: [task] } }).body;
    for (const text of ["First line\nSecond", "&lt;script>unsafe&lt;/script>", "Bug", "In progress", "Urgent", "whitespace-pre-wrap"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("<script>");
  });

  it("shows parent, model, attachments, files and both directions of related tasks", () => {
    const parent = { ...task, id: "parent", title: "Parent task" };
    const related = { ...task, id: "related", title: "Related task" };
    const incoming = { ...task, id: "incoming", title: "Incoming task", relatedTaskIds: [task.id] };
    const detailed = { ...task, parentId: parent.id, modelRef: "provider/model", links: ["docs/spec.md", "<unsafe>"], relatedTaskIds: [related.id] };
    const html = render(WorkspaceSidebarTaskDetails, { props: {
      task: detailed, parent, tasks: [detailed, parent, related, incoming], attachmentCount: 2,
    } }).body;
    for (const text of ["Parent task", "provider/model", "Attachments", ">2</dd>", "docs/spec.md", "&lt;unsafe>", "Related task", "Incoming task"]) {
      expect(html).toContain(text);
    }
  });

  it("provides an empty-description fallback and omits absent metadata", () => {
    const html = render(WorkspaceSidebarTaskDetails, { props: { task: { ...task, description: "  " }, tasks: [] } }).body;
    expect(html).toContain("No description.");
    for (const field of ["Parent", "Model", "Attachments", "Related tasks", "Links"]) expect(html).not.toContain(`<dt>${field}</dt>`);
  });
});
