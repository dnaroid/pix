import { describe, expect, it } from "vitest";
import { searchProjectTasks, searchRecentCommits } from "./project-search";
import type { ProjectTask, ProjectTaskDocument } from "./project-tasks";
import type { GitHistoryEntry } from "./git-workflow";

const task = (id: string, changes: Partial<ProjectTask> = {}): ProjectTask => ({
  id, title: "Fix renderer", description: "Cancellation races", type: "bug", status: "done", priority: "high",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...changes,
});
const document = (tasks: ProjectTask[]): ProjectTaskDocument => ({ version: 1, tasks });
const commit = (index = 1, changes: Partial<GitHistoryEntry> = {}): GitHistoryEntry => ({
  hash: index.toString(16).padStart(40, "0"), shortHash: "abcdef1", subject: "Fix renderer", author: "Alex", date: "2026-01-01", ...changes,
});

describe("local project search metadata", () => {
  it("finds completed tasks by title, description, stable ID and metadata", () => {
    for (const query of ["RENDERER", "cancellation", "stable-123", "bug", "done", "high"]) {
      const hits = searchProjectTasks(document([task("stable-123")]), query);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ kind: "tasks", taskId: "stable-123", id: "tasks:stable-123" });
    }
  });
  it("uses the panel's description-only label and ranks title matches first", () => {
    const hits = searchProjectTasks(document([
      task("description", { title: "", description: "Renderer work\nSecond line" }),
      task("body", { title: "Other", description: "Renderer work" }),
    ]), "renderer");
    expect(hits.map(hit => hit.taskId)).toEqual(["description", "body"]);
    expect(hits[0]?.title).toBe("Renderer work");
  });
  it("bounds task results and snippets and does not match empty queries", () => {
    const doc = document(Array.from({ length: 25 }, (_, i) => task(String(i), { description: "x".repeat(1000) })));
    expect(searchProjectTasks(doc, "renderer")).toHaveLength(20);
    expect(searchProjectTasks(doc, "renderer")[0]!.snippet.length).toBeLessThan(550);
    expect(searchProjectTasks(doc, " ")).toEqual([]);
  });
  it("finds commits by subject, hash prefix and author without requiring diffs", () => {
    const entry = commit(1, { hash: `abcdef1${"0".repeat(33)}` });
    for (const query of ["RENDERER", "abcdef", "alex"]) {
      expect(searchRecentCommits([entry], query)[0]).toMatchObject({ kind: "commits", hash: entry.hash, commit: entry });
    }
  });
  it("searches candidates beyond the source-control history window and bounds matches", () => {
    const history = Array.from({ length: 31 }, (_, i) => commit(i + 1));
    history[30]!.subject = "Outside window";
    expect(searchRecentCommits(history, "outside")[0]?.commit).toBe(history[30]);
    expect(searchRecentCommits(history, "renderer")).toHaveLength(20);
    expect(searchRecentCommits(history, " ")).toEqual([]);
    expect(searchRecentCommits([commit(1, { hash: "../unsafe" })], "renderer")).toEqual([]);
    expect(searchRecentCommits([commit(1, { hash: "a".repeat(64) })], "renderer")).toHaveLength(1);
  });
});
