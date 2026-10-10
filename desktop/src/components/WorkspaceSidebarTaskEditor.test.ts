import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import WorkspaceSidebarTaskEditor from "./WorkspaceSidebarTaskEditor.svelte";

function markup(busy: boolean) {
  return render(WorkspaceSidebarTaskEditor, { props: {
    editingTaskId: "task-1", busy, title: "Local draft", description: "Unsaved description",
    editorAttachments: [], taskType: "idea", titleInput: null,
    onChooseAttachments: async () => {}, onPasteAttachments: async () => {},
    onRemoveAttachment: () => {}, onOpenAttachment: () => {}, onClose: () => {}, onSubmit: () => {},
  } }).body;
}

describe("task editor save locking", () => {
  it("shows parent, epic, related tasks, project files, attachments and optional model in the editor", () => {
    const parent = { id: "parent", title: "Parent task", type: "idea" as const, status: "todo" as const,
      priority: "medium" as const, epic: true, createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z" };
    const related = { ...parent, id: "related", title: "Related task", epic: false };
    const task = { ...parent, id: "task-1", title: "Current task", epic: false, parentId: "parent", relatedTaskIds: ["related"] };
    const html = render(WorkspaceSidebarTaskEditor, { props: {
      editingTaskId: task.id, busy: false, title: task.title, description: "Description", taskType: "feature",
      editorParentId: task.parentId, editorRelatedTaskIds: [related.id],
      editorLinks: ["docs/spec.md", ".pi/artifacts/check/report.txt"],
      editorModelRef: "provider/smart-model", tasks: [parent, task, related],
      configOptions: [], editorAttachments: [], titleInput: null,
      onChooseAttachments: async () => {}, onPasteAttachments: async () => {},
      onRemoveAttachment: () => {}, onOpenAttachment: () => {}, onClose: () => {}, onSubmit: () => {},
    } }).body;
    for (const part of ["Hierarchy", "Parent task", "Related tasks", "Subtasks", "Assigned model", "Related files &amp; artifacts", "Attached files"]) {
      expect(html).toContain(part);
    }
    expect(html).toContain("provider/smart-model");
    expect(html).toContain("docs/spec.md");
    expect(html).toContain(".pi/artifacts/check/report.txt");
    expect(html).toContain("Related task");
  });

  it("locks every form control during save without preventing explicit close", () => {
    const html = markup(true);
    expect(html).toMatch(/<fieldset disabled/);
    expect(html).toMatch(/<button[^>]*aria-label="Close task editor"[^>]*>/);
    expect(html.match(/<button[^>]*aria-label="Close task editor"[^>]*>/)?.[0]).not.toContain("disabled");
    expect(html).toContain("Local draft");
  });

  it("unlocks the same draft after conflict or other failed save", () => {
    const html = markup(false);
    expect(html).not.toMatch(/<fieldset disabled/);
    expect(html).toContain("Local draft");
    expect(html).toContain("Unsaved description");
    expect(html).toContain('aria-label="Task type"');
    expect(html).toContain('>Idea</span>');
    expect(html).not.toContain('<select');
  });

  it("blocks submission when existing SQLite attachments could not be loaded", () => {
    const html = render(WorkspaceSidebarTaskEditor, { props: {
      editingTaskId: "task-1", busy: false, attachmentError: "broken attachment blob",
      title: "Local draft", description: "Preserve draft", editorAttachments: [],
      taskType: "feature", titleInput: null, onChooseAttachments: async () => {},
      onPasteAttachments: async () => {}, onRemoveAttachment: () => {},
      onOpenAttachment: () => {}, onClose: () => {}, onSubmit: () => {},
    } }).body;
    expect(html).toContain('role="alert"');
    expect(html).toContain("broken attachment blob");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save/);
  });
});
