import { describe, expect, it, vi } from "vitest";
import { createSessionStepNavigation } from "./session-step-navigation";
import type { ToolItem, TranscriptItem } from "../lib/transcript-types";
import type { TranscriptState } from "../lib/transcript";

function todo(id: string, rawInput: unknown): ToolItem {
  return { type: "tool", id, toolCallId: id, name: "todo", title: "todo", kind: "other", status: "completed", rawInput, content: "", diffs: [], attachments: [] };
}
const step = { id: 1, subject: "Ship" };

function harness(pages: TranscriptItem[][], initial: TranscriptItem[] = []) {
  let transcript: TranscriptState = { items: initial };
  let sessionId: string | null = "s1";
  const reveal = vi.fn(async () => true);
  const reportError = vi.fn();
  const loadOlder = vi.fn(async () => {
    const page = pages.shift();
    if (!page) return false;
    transcript = { items: [...page, ...transcript.items] };
    return true;
  });
  const nav = createSessionStepNavigation({
    activeSessionId: () => sessionId,
    transcript: () => transcript,
    loadOlder,
    revealActivityEntry: reveal,
    reportError,
  });
  return { nav, reveal, reportError, loadOlder, switchSession: (id: string | null) => { sessionId = id; } };
}

describe("session step navigation", () => {
  it("pages older history until the step start is loaded, then reveals it", async () => {
    const h = harness([[todo("start", { action: "update", id: 1, status: "in_progress" })], [todo("never", {})]], [todo("x", { action: "list" })]);
    await expect(h.nav.jumpToStep("s1", step)).resolves.toBe(true);
    expect(h.loadOlder).toHaveBeenCalledTimes(1);
    expect(h.reveal).toHaveBeenCalledWith("activity-group:start", "start");
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("reports when history is exhausted or the plan boundary has no match", async () => {
    const exhausted = harness([]);
    await expect(exhausted.nav.jumpToStep("s1", step)).resolves.toBe(false);
    expect(exhausted.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("step #1") }));

    const boundary = harness([], [todo("clear", { action: "clear" })]);
    await boundary.nav.jumpToStep("s1", step);
    expect(boundary.loadOlder).not.toHaveBeenCalled();
    expect(boundary.reportError).toHaveBeenCalledTimes(1);
  });

  it("drops a stale jump after a session switch or a newer jump", async () => {
    let release!: () => void;
    const h = harness([]);
    h.loadOlder.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(false); }));
    const pending = h.nav.jumpToStep("s1", step);
    h.switchSession("s2");
    release();
    await expect(pending).resolves.toBe(false);
    expect(h.reportError).not.toHaveBeenCalled();

    const g = harness([]);
    let releaseFirst!: () => void;
    g.loadOlder.mockImplementationOnce(() => new Promise<boolean>((resolve) => { releaseFirst = () => resolve(false); }));
    const first = g.nav.jumpToStep("s1", step);
    g.nav.cancel();
    releaseFirst();
    await expect(first).resolves.toBe(false);
    expect(g.reportError).not.toHaveBeenCalled();
    await expect(g.nav.jumpToStep("other", step)).resolves.toBe(false);
  });
});
