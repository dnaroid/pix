import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import { EMPTY_SESSION_ACTIVITY } from "../lib/session-activity";
import type { SessionTodoSnapshot } from "../lib/session-todos";
import SessionActivityStatusHud from "./SessionActivityStatusHud.svelte";

function renderProgress(completedTodos: number, totalTodos: number, sessionActivityOpen = false) {
  return render(SessionActivityStatusHud, {
    props: {
      summary: { ...EMPTY_SESSION_ACTIVITY, completedTodos, totalTodos, openTodos: totalTodos - completedTodos },
      subagentSnapshot: undefined,
      todoSnapshot: undefined,
      promptRunning: false,
      sessionNeedsInput: false,
      sessionActivityOpen,
      onOpenSessionActivity: () => {},
    },
  }).body;
}

describe("status HUD todo progress ring", () => {
  it.each([
    [true, true, false, 2],
    [true, false, false, 1],
    [false, true, false, 1],
    [false, false, false, 0],
    [true, true, true, 0],
  ])("renders separators only between visible groups (agents=%s plan=%s inspector=%s)", (agents, plan, inspector, count) => {
    const html = render(SessionActivityStatusHud, { props: {
      summary: { ...EMPTY_SESSION_ACTIVITY, activeSubagents: agents ? 1 : 0, completedTodos: 0, totalTodos: plan ? 2 : 0, openTodos: plan ? 2 : 0 },
      subagentSnapshot: agents ? { version: 1, count: 1, checkedAt: 1, runs: [{ runDir: "/run", agents: [{ id: "worker", status: "running" }] }] } : undefined,
      todoSnapshot: undefined,
      promptRunning: false,
      sessionNeedsInput: false,
      sessionActivityOpen: inspector,
      leadingSeparator: true,
      onOpenSessionActivity: () => {},
    } }).body;
    expect(html.match(/data-status-separator=/g) ?? []).toHaveLength(count);
    if (count) expect(html).toContain("h-3 w-px shrink-0 bg-border");
  });

  it("omits the leading separator when Observer is absent", () => {
    expect(renderProgress(0, 2)).not.toContain("data-status-separator");
  });
  it.each([[1, 5, 20], [2, 4, 50], [10, 40, 25], [0, 40, 0]])(
    "renders %i/%i as %i percent in a ring beside the centered count",
    (completed, total, percentage) => {
      const html = renderProgress(completed, total);
      expect(html).toContain(`${completed}/${total}`);
      expect(html).toContain(`stroke-dashoffset="${100 - percentage}"`);
      expect(html.match(/data-session-todo-progress/g)).toHaveLength(1);
      expect(html).toContain('pathLength="100"');
      expect(html).toContain('stroke-dasharray="100"');
      expect(html).toContain("text-muted-foreground/25");
      expect(html).toContain("text-tool-info");
      expect(html).toContain("flex h-6 items-center justify-center gap-1");
      expect(html).not.toContain("flex-col");
      expect(html).not.toContain("lucide-list-todo");
      expect(html).not.toContain("style=\"width:");
    },
  );

  it("preserves existing hiding rules for empty, finished and inspector-visible plans", () => {
    for (const html of [renderProgress(0, 0), renderProgress(4, 4), renderProgress(2, 4, true)]) {
      expect(html).not.toContain("data-session-todo-progress");
    }
  });
});

describe("status HUD plan popup emphasis", () => {
  it.each(["pending", "in_progress"] as const)("keeps the current %s item bright and dims future items", (status) => {
    const todoSnapshot: SessionTodoSnapshot = {
      version: 1,
      checkedAt: 1,
      details: {
        action: "list",
        params: {},
        nextId: 5,
        tasks: [
          { id: 1, subject: "Current", status },
          { id: 2, subject: "Future", status: "pending" },
          { id: 3, subject: "Deferred", status: "deferred" },
          { id: 4, subject: "Done", status: "completed" },
        ],
      },
    };
    const html = render(SessionActivityStatusHud, {
      props: {
        summary: { ...EMPTY_SESSION_ACTIVITY, completedTodos: 1, totalTodos: 4, openTodos: 3 },
        subagentSnapshot: undefined,
        todoSnapshot,
        promptRunning: false,
        sessionNeedsInput: false,
        sessionActivityOpen: false,
        onOpenSessionActivity: () => {},
      },
    }).body;
    const articles = html.match(/<article\b[^>]*>/g) ?? [];
    expect(articles).toHaveLength(4);
    expect(articles[0]).toContain('data-session-todo-current="true"');
    expect(articles[0]).not.toContain("opacity-");
    expect(articles[1]).toContain("opacity-70");
    expect(articles[2]).toContain("opacity-70");
    expect(articles[3]).toContain("opacity-60");
    expect(articles[3]).not.toContain("opacity-70");
  });
});
