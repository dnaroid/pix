import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import { EMPTY_SESSION_ACTIVITY } from "../lib/session-activity";
import type { SessionTodoSnapshot } from "../lib/session-todos";
import SessionActivityStatusHud from "./SessionActivityStatusHud.svelte";

function renderProgress(completedTodos: number, totalTodos: number) {
  return render(SessionActivityStatusHud, {
    props: {
      summary: { ...EMPTY_SESSION_ACTIVITY, completedTodos, totalTodos, openTodos: totalTodos - completedTodos },
      subagentSnapshot: undefined,
      todoSnapshot: undefined,
      promptRunning: false,
      sessionNeedsInput: false,
    },
  }).body;
}

describe("status HUD todo progress ring", () => {
  it("shows independent child plan rings next to agent names, including overflow agents", () => {
    const agents = Array.from({ length: 8 }, (_, index) => ({ id: `worker-${index}`, status: "running" as const,
      todoProgress: index === 0 || index === 7 ? { completed: 1, total: 5 } : undefined }));
    const html = render(SessionActivityStatusHud, { props: {
      summary: { ...EMPTY_SESSION_ACTIVITY, activeSubagents: 8 },
      subagentSnapshot: { version: 1, count: 8, checkedAt: 1, runs: [{ runDir: "/run", agents }] },
      todoSnapshot: undefined, promptRunning: false, sessionNeedsInput: false,
    } }).body;
    expect(html.match(/data-session-subagent-todo-progress/g)).toHaveLength(2);
    expect(html.match(/stroke-dashoffset="80"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Steps 1\/5"/g)).toHaveLength(2);
    // Overflow agents retain their popup progress, but have no individual status icon.
    expect(html.match(/data-session-subagent-status-progress/g)).toHaveLength(1);
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('aria-valuemax="5"');
    expect(html).toContain('width: 20%');
    expect(html).toContain("absolute top-[2px] right-0.5 left-0.5 h-[2px]");
    expect(html).toContain("bg-muted-foreground/25 opacity-70");
    expect(html).toContain("relative grid h-full w-6");
    expect(html).not.toContain("data-session-todo-progress");
  });

  it.each([undefined, { completed: 0, total: 0 }, { completed: 5, total: 5 }])("hides absent, empty and finished child plans (%j)", (todoProgress) => {
    const html = render(SessionActivityStatusHud, { props: {
      summary: { ...EMPTY_SESSION_ACTIVITY, activeSubagents: 1 },
      subagentSnapshot: { version: 1, count: 1, checkedAt: 1, runs: [{ runDir: "/run", agents: [{ id: "worker", status: "running", todoProgress }] }] },
      todoSnapshot: undefined, promptRunning: false, sessionNeedsInput: false,
    } }).body;
    expect(html).not.toContain("data-session-subagent-todo-progress");
    expect(html).not.toContain("data-session-subagent-status-progress");
  });
  it("shows an empty track above the icon for a not-yet-completed child plan", () => {
    const html = render(SessionActivityStatusHud, { props: {
      summary: { ...EMPTY_SESSION_ACTIVITY, activeSubagents: 1 },
      subagentSnapshot: { version: 1, count: 1, checkedAt: 1, runs: [{ runDir: "/run", agents: [{ id: "worker", status: "running", todoProgress: { completed: 0, total: 5 } }] }] },
      todoSnapshot: undefined, promptRunning: false, sessionNeedsInput: false,
    } }).body;
    expect(html).toContain("data-session-subagent-status-progress");
    expect(html).toContain('width: 0%');
    expect(html).toContain('aria-valuenow="0"');
  });
  it("renders live activity as initially closed click popups without an inspector opener", () => {
    const html = renderProgress(1, 3);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('hidden');
    expect(html).not.toContain("Open session activity");
  });

  it("keeps excess agents accessible in the +N click popup", () => {
    const agents = Array.from({ length: 8 }, (_, index) => ({ id: `worker-${index}`, status: "running" as const }));
    const html = render(SessionActivityStatusHud, { props: {
      summary: { ...EMPTY_SESSION_ACTIVITY, activeSubagents: 8 },
      subagentSnapshot: { version: 1, count: 8, checkedAt: 1, runs: [{ runDir: "/run", agents }] },
      todoSnapshot: undefined, promptRunning: false, sessionNeedsInput: false,
    } }).body;
    expect(html).toContain("+2");
    expect(html).toContain("worker-6");
    expect(html).toContain("worker-7");
    expect(html).toContain('aria-label="More active subagents"');
    expect(html).toContain('aria-expanded="false"');
  });
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("does not render separators (agents=%s plan=%s)", (agents, plan) => {
    const html = render(SessionActivityStatusHud, { props: {
      summary: { ...EMPTY_SESSION_ACTIVITY, activeSubagents: agents ? 1 : 0, completedTodos: 0, totalTodos: plan ? 2 : 0, openTodos: plan ? 2 : 0 },
      subagentSnapshot: agents ? { version: 1, count: 1, checkedAt: 1, runs: [{ runDir: "/run", agents: [{ id: "worker", status: "running" }] }] } : undefined,
      todoSnapshot: undefined,
      promptRunning: false,
      sessionNeedsInput: false,
    } }).body;
    expect(html).not.toContain("data-status-separator");
    expect(html).not.toContain("h-3 w-px shrink-0 bg-border");
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

  it("preserves existing hiding rules for empty and finished plans", () => {
    for (const html of [renderProgress(0, 0), renderProgress(4, 4)]) {
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

describe("status HUD executing plan block", () => {
  const todoSnapshot: SessionTodoSnapshot = {
    version: 1, checkedAt: 1,
    details: { action: "list", params: {}, nextId: 2, tasks: [{ id: 1, subject: "Current", status: "in_progress" }] },
  };
  const props = {
    summary: { ...EMPTY_SESSION_ACTIVITY, completedTodos: 0, totalTodos: 1, openTodos: 1 },
    subagentSnapshot: undefined, todoSnapshot, promptRunning: false, sessionNeedsInput: false,
  };

  it("shows the launched plan above Steps with file checklist progress", () => {
    const html = render(SessionActivityStatusHud, { props: { ...props, sessionPlan: { path: ".pi/plans/releases/rollout.md", progress: { completed: 2, total: 5 } }, onOpenPlan: () => {} } }).body;
    expect(html).toContain("data-session-todo-plan");
    expect(html).toContain('aria-label="Open plan releases/rollout.md"');
    expect(html).toContain("data-plan-checklist-progress");
    expect(html.indexOf("data-session-todo-plan")).toBeLessThan(html.indexOf(">Steps</span>"));
  });

  it("omits the block for sessions not launched from a plan", () => {
    expect(render(SessionActivityStatusHud, { props }).body).not.toContain("data-session-todo-plan");
  });
});

describe("status HUD sub-agent sessions", () => {
  it("offers an open-session action for active agents", () => {
    const html = render(SessionActivityStatusHud, { props: {
      summary: { ...EMPTY_SESSION_ACTIVITY, activeSubagents: 1 },
      subagentSnapshot: { version: 1, count: 1, checkedAt: 1, runs: [{ runDir: "/run", agents: [{ id: "worker", status: "running" }] }] },
      todoSnapshot: undefined, promptRunning: false, sessionNeedsInput: false, onOpenSubagentSession: () => {},
    } }).body;
    expect(html).toContain("data-session-subagent-open");
  });
});

describe("status HUD step actions", () => {
  const todoSnapshot: SessionTodoSnapshot = {
    version: 1, checkedAt: 1,
    details: { action: "list", params: {}, nextId: 3, tasks: [
      { id: 1, subject: "Done", status: "completed" },
      { id: 2, subject: "Current", status: "in_progress" },
    ] },
  };
  const base = {
    summary: { ...EMPTY_SESSION_ACTIVITY, completedTodos: 1, totalTodos: 2, openTodos: 1 },
    subagentSnapshot: undefined, todoSnapshot, sessionNeedsInput: false,
  };

  it("offers jump and rerun per step only when handlers exist", () => {
    expect(render(SessionActivityStatusHud, { props: { ...base, promptRunning: false } }).body).not.toContain("data-session-todo-actions");
    const html = render(SessionActivityStatusHud, { props: {
      ...base, promptRunning: false, canJumpToSteps: true, canRerunSteps: true, onJumpToStep: () => {}, onRerunStep: () => {},
    } }).body;
    expect(html.match(/data-session-todo-jump/g)).toHaveLength(2);
    expect(html.match(/data-session-todo-rerun/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Go to where step #2 started"');
    expect(html).toContain('aria-label="Rerun step #2 in this session"');
    expect(html).not.toMatch(/data-session-todo-(jump|rerun)[^>]*disabled/);
  });

  it("disables rerun while a prompt runs and jump when navigation is unavailable", () => {
    const html = render(SessionActivityStatusHud, { props: {
      ...base, promptRunning: true, canJumpToSteps: false, canRerunSteps: true, onJumpToStep: () => {}, onRerunStep: () => {},
    } }).body;
    expect(html.match(/data-session-todo-rerun[^>]*disabled/g)).toHaveLength(2);
    expect(html.match(/data-session-todo-jump[^>]*disabled/g)).toHaveLength(2);
  });
});
