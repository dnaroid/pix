import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { AgentControlState } from "../lib/agent-control";
import PromptComposerActivityRow from "./PromptComposerActivityRow.svelte";

function renderRow(
  agentControlState: AgentControlState,
  promptRunning: boolean,
  options: { showControls?: boolean; activity?: { action: string; moreCount: number } } = {},
) {
  return render(PromptComposerActivityRow, {
    props: {
      agentControlState,
      promptRunning,
      onPause: () => {},
      onCancel: () => {},
      onContinue: () => {},
      ...options,
    },
  }).body;
}

describe("composer activity row rendering", () => {
  it("keeps Pause and Stop available even before activity metadata arrives", () => {
    const html = renderRow("idle", true);
    expect(html).toContain("Working");
    expect(html).toContain('aria-label="Pause after current turn"');
    expect(html).toContain('aria-label="Stop response"');
    expect(html).not.toContain('aria-label="Continue response"');
  });

  it("keeps pending Pause pressed and clickable to withdraw the request", () => {
    const html = renderRow("pause-requested", true);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('aria-label="Cancel pending pause"');
    expect(buttons[0]).toContain('aria-pressed="true"');
    expect(buttons[0]).toContain("bg-primary/15");
    expect(buttons[0]).toContain("text-primary");
    expect(buttons[0]).toContain("ring-primary/60");
    for (const button of buttons) expect(button).not.toMatch(/\sdisabled(?:[=\s>])/);
  });

  it("keeps unrequested Pause neutral and visually distinct from pending Pause", () => {
    const button = renderRow("running", true).match(/<button\b[^>]*>/)?.[0] ?? "";
    expect(button).toContain('aria-pressed="false"');
    expect(button).toContain("bg-panel");
    expect(button).not.toContain("bg-primary/15");
    expect(button).not.toContain("ring-primary/60");
  });

  it("disables Pause during resuming but retains Stop", () => {
    const html = renderRow("resuming", true);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatch(/\sdisabled(?:[=\s>])/);
    expect(buttons[1]).not.toMatch(/\sdisabled(?:[=\s>])/);
  });

  it("enables Pause and Stop once a recovered-question continuation is running", () => {
    const html = renderRow("running", true);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(html).toContain('aria-label="Pause after current turn"');
    expect(html).toContain('aria-label="Stop response"');
    for (const button of buttons) expect(button).not.toMatch(/\sdisabled(?:[=\s>])/);
  });

  it.each(["paused", "continuable"] as const)("keeps the row with Continue while %s without live activity", (state) => {
    const html = renderRow(state, false);
    expect(html).toContain(state === "paused" ? "Agent paused" : "Ready to continue");
    expect(html).toContain('aria-label="Continue response"');
    expect(html).not.toContain('aria-label="Stop response"');
    expect(html).not.toContain('aria-label="Pause after current turn"');
  });

  it("hides the row after normal completion or cancellation", () => {
    expect(renderRow("idle", false)).not.toContain("data-composer-activity-row");
  });

  it("does not expose run actions in questionnaire mode", () => {
    const html = renderRow("idle", true, {
      showControls: false,
      activity: { action: "Waiting for input", moreCount: 0 },
    });
    expect(html).toContain("Waiting for input");
    expect(html).not.toContain("<button");
    expect(renderRow("paused", false, { showControls: false })).not.toContain("data-composer-activity-row");
  });
});
