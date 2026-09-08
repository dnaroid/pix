import { describe, expect, it } from "vitest";
import {
  PROJECT_TODO_PATH,
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
});
