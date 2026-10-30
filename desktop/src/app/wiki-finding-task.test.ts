import { describe, expect, it, vi } from "vitest";
import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import type { WikiFinding } from "../lib/wiki-conflicts-index";
import { createWikiFindingTask, wikiFindingTaskDraft, type WikiFindingTaskOptions } from "./wiki-finding-task";

const citation = (path: string, quote: string, startLine = 1, endLine = startLine): KnowledgeCitation => ({ path, quote, startLine, endLine });
const finding = (extra: Partial<WikiFinding> = {}): WikiFinding => ({
  id: "f".repeat(64), kind: "conflict", internal: false,
  draft: citation("wiki/a.md", "Fighters have 6 points.", 3), existing: citation("wiki/b.md", "Fighters have 4 points.\nSecond.", 5, 6),
  explanation: "Point counts differ.", reportPath: "wiki/a.md", checkedAt: "2026-10-30T00:00:00.000Z", reportLanguage: "ru",
  current: true, modelRef: "test/judge", reportPaths: ["wiki/a.md"], stale: false, decisionPartial: false, ...extra,
});

function options(extra: Partial<WikiFindingTaskOptions> = {}) {
  const calls: string[] = [];
  const base: WikiFindingTaskOptions = {
    prepare: vi.fn(async () => { calls.push("prepare"); return true; }),
    newId: () => "task-1",
    create: vi.fn(async () => { calls.push("create"); return true; }),
    decide: vi.fn(async () => { calls.push("decide"); return true; }),
    open: vi.fn(() => { calls.push("open"); }),
    isCurrent: () => true,
    ...extra,
  };
  return { calls, options: base };
}

describe("Wiki finding task", () => {
  it("drafts a task with both sides, the explanation, the finding id and unique links", () => {
    const draft = wikiFindingTaskDraft(finding());
    expect(draft).toMatchObject({ title: "Разрешить противоречие Wiki: a.md ↔ b.md", type: "bug", links: ["wiki/a.md", "wiki/b.md"] });
    expect(draft.description).toContain("wiki/b.md:L5–6\n> Fighters have 4 points.\n> Second.");
    expect(draft.description).toContain(`Находка: ${"f".repeat(64)}`);
    const internal = wikiFindingTaskDraft(finding({ internal: true, kind: "uncertainty", reportLanguage: "en", existing: citation("wiki/a.md", "Other.") }));
    expect(internal).toMatchObject({ title: "Clarify Wiki uncertainty: a.md", type: "improvement", links: ["wiki/a.md"] });
  });

  it("creates the task before linking it, keeps the deferred note, then opens it", async () => {
    const { calls, options: opts } = options();
    const deferred = finding({ decision: { findingId: "f".repeat(64), verdict: "deferred", note: "Ask owner", at: "2026-10-30T01:00:00.000Z" } });
    expect(await createWikiFindingTask(deferred, opts)).toBe("task-1");
    expect(calls).toEqual(["prepare", "create", "decide", "open"]);
    expect(opts.create).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1" }));
    expect(opts.decide).toHaveBeenCalledWith(deferred, { verdict: "deferred", note: "Ask owner", taskId: "task-1" });
    expect(opts.open).toHaveBeenCalledWith("task-1");
  });

  it("throws a visible error when tasks are unavailable or creation fails, without linking", async () => {
    const unavailable = options({ prepare: async () => false });
    await expect(createWikiFindingTask(finding(), unavailable.options)).rejects.toThrow(/недоступны/u);
    const failed = options({ create: async () => false });
    await expect(createWikiFindingTask(finding({ reportLanguage: "en" }), failed.options)).rejects.toThrow(/Could not create/u);
    expect(failed.options.decide).not.toHaveBeenCalled();
  });

  it("stops after a project switch: no link or open into the new project, no error", async () => {
    let current = true;
    const { options: opts } = options({ isCurrent: () => current, create: vi.fn(async () => { current = false; return true; }) });
    expect(await createWikiFindingTask(finding(), opts)).toBe("task-1");
    expect(opts.decide).not.toHaveBeenCalled();
    expect(opts.open).not.toHaveBeenCalled();
    current = true;
    const switched = options({ prepare: async () => { current = false; return true; }, isCurrent: () => current });
    expect(await createWikiFindingTask(finding(), switched.options)).toBeNull();
    expect(switched.options.create).not.toHaveBeenCalled();
  });
});
