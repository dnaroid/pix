import { describe, expect, it } from "vitest";
import {
  PROJECT_TODO_PATH,
  isCanonicalProjectPlanPath,
  isEditableProjectMarkdown,
  projectDocumentLabel,
} from "./project-documents";

describe("project documents", () => {
  it("limits editing to TODO.md and Markdown plans", () => {
    expect(isEditableProjectMarkdown(PROJECT_TODO_PATH)).toBe(true);
    expect(isEditableProjectMarkdown(".pi/plans/release.md")).toBe(true);
    expect(isEditableProjectMarkdown(".pi/plans/releases/v2.MD")).toBe(true);
    expect(isEditableProjectMarkdown("README.md")).toBe(false);
    expect(isEditableProjectMarkdown(".pi/plans/../secret.md")).toBe(false);
    expect(isEditableProjectMarkdown(".pi/tasks.jsonc")).toBe(false);
  });

  it("uses the file name as the compact plan label", () => {
    expect(projectDocumentLabel(".pi/plans/releases/v2.md")).toBe("releases/v2.md");
  });

  it("marks only canonical Markdown plan saves as Registry dirty", () => {
    expect(isCanonicalProjectPlanPath(".pi/plans/roadmap.md")).toBe(true);
    expect(isCanonicalProjectPlanPath(".pi/plans/releases/v2.MD")).toBe(true);
    expect(isCanonicalProjectPlanPath(".pi\\plans\\releases\\v2.md")).toBe(true);
    for (const path of [
      ".pi/TODO.md", ".pi/tasks.sqlite", ".pi/plans/notes.md.tmp",
      ".pi/plans/roadmap.md.bak", ".pi/plans/.cache/note.md",
      ".pi/plans/cache/note.md", ".pi/plans/artifacts/report.md",
      ".pi/plans/dist/generated.md", ".pi/plans/tmp/draft.md",
      ".pi/plans/../other.md", ".pi/plans/notes.txt",
    ]) {
      expect(isCanonicalProjectPlanPath(path), path).toBe(false);
    }
  });
});
