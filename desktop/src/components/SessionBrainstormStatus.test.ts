import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { BrainstormRun, SessionBrainstormSnapshot } from "../lib/session-brainstorm";
import SessionBrainstormStatus from "./SessionBrainstormStatus.svelte";

const run: BrainstormRun = {
  runId: "run1", runDir: ".pi/brainstorms/run1", topic: "Choose a name", status: "running", round: 3,
  participants: [{ slot: 1, sessionId: "p1", name: "Luna", model: "openai-codex/gpt-6-luna", status: "running", round: 3 }],
};
const html = (runs?: BrainstormRun[], trailingSeparator = false) => render(SessionBrainstormStatus, {
  props: { snapshot: runs && { version: 1, checkedAt: 1, runs } as SessionBrainstormSnapshot, trailingSeparator },
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
  it("shows a brain, round, and initially closed click details", () => {
    const result = html([run]);
    for (const text of ["lucide-brain", "3/5", 'role="dialog"', "Choose a name", "Luna", "openai-codex/gpt-6-luna", "Running", "aria-controls", "aria-expanded"]) {
      expect(result).toContain(text);
    }
    expect(result).not.toContain("BS");
    expect(result).toContain('aria-expanded="false"');
    expect(result).toContain("hidden");
  });
  it.each(["awaiting_synthesis", "awaiting_finalization", "complete", "incomplete"] as const)("retains %s state", (status) => {
    expect(html([{ ...run, status }])).toContain("data-brainstorm-status");
  });
  it("retains explicit participant-session navigation in the council popup", () => {
    const result = render(SessionBrainstormStatus, { props: {
      snapshot: { version: 1, checkedAt: 1, runs: [run] },
      onOpenParticipant: () => {},
    } }).body;
    expect(result).toContain('aria-label="Open participant Luna"');
    expect(result).toContain("Open session");
  });
  it("prioritizes nonterminal runs while showing all runs in the tooltip", () => {
    const result = html([run, { ...run, runId: "run2", topic: "Earlier completed work", status: "complete", round: 5 }]);
    expect(result).toContain("Open council. Running. Round 3 of 5");
    expect(result).toContain("Earlier completed work");
  });
});
