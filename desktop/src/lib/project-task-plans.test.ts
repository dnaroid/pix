import { describe, expect, it } from "vitest";
import { isCanonicalProjectPlanPath } from "./project-documents";
import type { ProjectTask } from "./project-tasks";
import { buildTaskPlanAuthoringPrompt, linkedTaskPlan, planOwners, taskPlanPath, taskPlanRunContext, withTaskPlanLink } from "./project-task-plans";

const task: ProjectTask = {
  id: "T-42", title: "Add Work panel: Plans!", type: "feature", status: "todo", priority: "medium",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("task plan links", () => {
  it("derives a canonical, slugged plan path", () => {
    expect(taskPlanPath(task)).toBe(".pi/plans/tasks/t-42-add-work-panel-plans.md");
    expect(taskPlanPath({ id: "../..", title: "" })).toBe(".pi/plans/tasks/task.md");
    expect(isCanonicalProjectPlanPath(taskPlanPath({ id: "x".repeat(200), title: "y".repeat(200) }))).toBe(true);
  });

  it("finds only saved-plan links and links idempotently first", () => {
    expect(linkedTaskPlan({ links: ["README.md", ".pi/plans/a.md"] })).toBe(".pi/plans/a.md");
    expect(linkedTaskPlan({ links: ["docs/x.md"] })).toBeUndefined();
    const linked = withTaskPlanLink({ ...task, links: ["README.md"] }, ".pi/plans/a.md", "later");
    expect(linked.links).toEqual([".pi/plans/a.md", "README.md"]);
    expect(linked.updatedAt).toBe("later");
    expect(withTaskPlanLink(linked, ".pi/plans/a.md", "again")).toBe(linked);
  });

  it("maps each plan to its first owning task", () => {
    const owners = planOwners([
      { ...task, id: "a", links: [".pi/plans/x.md"] },
      { ...task, id: "b", links: [".pi/plans/x.md"] },
      { ...task, id: "c", links: ["README.md"] },
    ]);
    expect(Object.keys(owners)).toEqual([".pi/plans/x.md"]);
    expect(owners[".pi/plans/x.md"]!.id).toBe("a");
  });

  it("asks only for the plan file and keeps run authorization out of authoring", () => {
    const prompt = buildTaskPlanAuthoringPrompt({ ...task, links: [".pi/plans/a.md", "README.md"] }, ".pi/plans/a.md");
    expect(prompt).toContain('save it at ".pi/plans/a.md"');
    expect(prompt).toContain("do not implement the plan");
    expect(prompt).toContain("Task id: T-42");
    expect(prompt).toContain("- README.md");
    expect(prompt).not.toContain("- .pi/plans/a.md");
    expect(prompt).not.toContain("authorizes updating");
    expect(taskPlanRunContext(task)).toContain("project task T-42");
  });
});
