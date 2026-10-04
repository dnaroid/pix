import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { BrainstormRun, SessionBrainstormSnapshot } from "../lib/session-brainstorm";
import SessionBrainstormStatus from "./SessionBrainstormStatus.svelte";

const run: BrainstormRun = {
  runId: "run1", runDir: ".pi/brainstorms/run1", topic: "Choose a name", status: "running", round: 3,
  participants: [{ slot: 1, sessionId: "p1", name: "Luna", model: "openai-codex/gpt-6-luna", status: "running", round: 3 }],
};
const html = (runs?: BrainstormRun[], trailingSeparator = false) => render(SessionBrainstormStatus, {
  props: { snapshot: runs && { version: 1, checkedAt: 1, runs } as SessionBrainstormSnapshot, trailingSeparator, onOpen: () => {} },
}).body;

describe("council status indicator", () => {
  it("adds a one-pixel separator only when council and a following group exist", () => {
    expect(html([run], true)).toContain('data-status-separator="brainstorm-next"');
    expect(html([run], true)).toContain("h-3 w-px shrink-0 bg-border");
    expect(html([run])).not.toContain("data-status-separator");
    expect(html([], true)).not.toContain("data-status-separator");
  });
  it("hides when there is no council", () => {
    expect(html()).not.toContain("data-brainstorm-status");
    expect(html([])).not.toContain("data-brainstorm-status");
  });
  it("shows a brain, round, and accessible hover details", () => {
    const result = html([run]);
    for (const text of ["lucide-brain", "3/5", 'role="tooltip"', "group-focus-within:block", "Choose a name", "Luna", "openai-codex/gpt-6-luna", "Running", "aria-describedby"]) {
      expect(result).toContain(text);
    }
    expect(result).not.toContain("BS");
  });
  it.each(["awaiting_synthesis", "awaiting_finalization", "complete", "incomplete"] as const)("retains %s state", (status) => {
    expect(html([{ ...run, status }])).toContain("data-brainstorm-status");
  });
  it("prioritizes nonterminal runs while showing all runs in the tooltip", () => {
    const result = html([run, { ...run, runId: "run2", topic: "Earlier completed work", status: "complete", round: 5 }]);
    expect(result).toContain("Open council. Running. Round 3 of 5");
    expect(result).toContain("Earlier completed work");
  });
});
