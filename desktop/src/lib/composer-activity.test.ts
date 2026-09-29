import { describe, expect, it } from "vitest";
import { composerActivity } from "./composer-activity";
import type { ToolItem, TranscriptItem } from "./transcript-types";

const live = {
  sessionId: "one", running: true, ready: true, historyLoading: false,
  draft: false, controlState: "idle" as const, waitingForInput: false,
};
const user: TranscriptItem = { type: "message", id: "u", role: "user", text: "go", attachments: [] };
const tool = (name: string, status: ToolItem["status"] = "in_progress"): ToolItem => ({
  type: "tool", id: name, toolCallId: name, name, title: name, kind: "other", status,
  content: "", diffs: [], attachments: [],
});

describe("composer activity", () => {
  it("follows the latest live action and counts concurrent entries without inheriting failures", () => {
    expect(composerActivity({ items: [user, tool("shell", "failed"), tool("read"), tool("apply_patch")] }, live))
      .toEqual({ action: "Making changes", moreCount: 1 });
    expect(composerActivity({ items: [user, tool("shell", "failed"), tool("read")] }, live))
      .toEqual({ action: "Reading code", moreCount: 0 });
  });

  it("shows thinking only for a live timed thought, not replayed history", () => {
    const thought: TranscriptItem = { type: "message", id: "t", role: "thought", text: "", attachments: [] };
    expect(composerActivity({ items: [user, thought] }, live)?.action).toBe("Working");
    expect(composerActivity({ items: [user, { ...thought, startedAtMs: 1 }] }, live)?.action).toBe("Thinking");
    expect(composerActivity({ items: [user, { ...thought, startedAtMs: 1, endedAtMs: 2 }] }, live)?.action).toBe("Working");
  });

  it("does not revive pending tools from an earlier turn", () => {
    expect(composerActivity({ items: [tool("shell"), user] }, live)).toEqual({ action: "Working", moreCount: 0 });
  });

  it.each([
    { sessionId: null }, { running: false }, { ready: false }, { historyLoading: true },
    { draft: true }, { controlState: "paused" as const }, { controlState: "continuable" as const },
  ])("hides for an inactive context %j even with stale live tools", (patch) => {
    expect(composerActivity({ items: [user, tool("read")] }, { ...live, ...patch })).toBeUndefined();
  });

  it("switches sessions, settles, and restarts without retaining the previous action", () => {
    const first = { items: [user, tool("read")] };
    expect(composerActivity(first, live)?.action).toBe("Reading code");
    expect(composerActivity(first, { ...live, sessionId: "two", running: false })).toBeUndefined();
    expect(composerActivity(first, { ...live, running: false })).toBeUndefined();
    expect(composerActivity({ items: [user, tool("read", "failed")] }, live)?.action).toBe("Working");
    expect(composerActivity({ items: [user, tool("shell")] }, live)?.action).toBe("Running command");
  });

  it("prioritizes input requests and never inspects raw tool payloads", () => {
    const call = { ...tool("read"), get rawInput(): unknown { throw new Error("payload access"); } };
    expect(composerActivity({ items: [user, call] }, live)?.action).toBe("Reading code");
    expect(composerActivity({ items: [user, call] }, { ...live, waitingForInput: true }))
      .toEqual({ action: "Waiting for input", moreCount: 0 });
  });
});
