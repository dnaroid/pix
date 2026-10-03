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

describe("status HUD todo mini-track", () => {
  it.each([[2, 4, 50], [10, 40, 25], [0, 40, 0]])(
    "renders %i/%i as %i percent in one continuous track",
    (completed, total, percentage) => {
      const html = renderProgress(completed, total);
      expect(html).toContain(`${completed}/${total}`);
      expect(html).toContain(`width: ${percentage}%`);
      expect(html.match(/data-session-todo-progress/g)).toHaveLength(1);
      expect(html).toContain("h-1 overflow-hidden rounded-full bg-muted-foreground/25");
      expect(html).toContain("block h-full rounded-full bg-tool-info");
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
