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
  it.each([
    ["repo_context", "Gathering project context"],
    ["repo_architecture", "Exploring architecture"],
    ["repo_structure", "Inspecting project structure"],
    ["repo_ast", "Inspecting code structure"],
    ["repo_explain", "Inspecting implementation"],
    ["repo_deps", "Checking dependencies"],
    ["repo_audit", "Auditing project knowledge"],
    ["session", "Reviewing session"],
    ["compress", "Compacting context"],
    ["brainstorm", "Consulting model council"],
    ["multi_tool_use.parallel", "Running parallel tools"],
    ["codemode", "Running code"],
    ["unknown", "Running tool"],
  ])("describes %s from metadata", (name, action) => {
    expect(composerActivity({ items: [user, tool(name)] }, live)?.action).toBe(action);
  });

  it("adds safe context for every active file or skill, never raw payloads", () => {
    const read = { ...tool("read"), path: "/private/project/composer-activity.ts",
      get rawInput(): unknown { throw new Error("payload access"); } };
    expect(composerActivity({ items: [user, read] }, live)?.action).toBe("Reading code · composer-activity.ts");
    expect(composerActivity({ items: [user, read, tool("repo_deps")] }, live))
      .toEqual({ action: "Reading code · composer-activity.ts • Checking dependencies", moreCount: 0 });
    expect(composerActivity({ items: [user, read, { ...tool("edit"), path: "C:\\project\\file.ts" }] }, live)?.action)
      .toBe("Reading code · composer-activity.ts • Making changes · file.ts");
    expect(composerActivity({ items: [user, { ...tool("read"), skillName: "pix-desktop-frontend" }] }, live)?.action)
      .toBe("Reading instructions · pix-desktop-frontend");
    expect(composerActivity({ items: [user, { ...tool("shell"), path: "/private/test.ts" }] }, live)?.action)
      .toBe("Running command");
  });

  it.each(["https://host/file?token=secret", "/tmp/file#secret", "/tmp/bad\nfile", "/tmp/bad\u202efile"])(
    "does not display unsafe path %j", (path) => {
      expect(composerActivity({ items: [user, { ...tool("read"), path }] }, live)?.action).toBe("Reading code");
    },
  );

  it("bounds context and drops settled context", () => {
    const read = { ...tool("read"), path: `/tmp/${"a".repeat(100)}` };
    expect(composerActivity({ items: [user, read] }, live)?.action).toBe(`Reading code · ${"a".repeat(61)}…`);
    expect(composerActivity({ items: [user, { ...read, status: "completed" }] }, live)?.action).toBe("Working");
  });

  it("lists all concurrent entries without inheriting failures or hiding repeated actions", () => {
    expect(composerActivity({ items: [user, tool("shell", "failed"), tool("read"), tool("apply_patch")] }, live))
      .toEqual({ action: "Reading code • Making changes", moreCount: 0 });
    expect(composerActivity({ items: [user, tool("shell", "failed"), tool("read")] }, live))
      .toEqual({ action: "Reading code", moreCount: 0 });
    expect(composerActivity({ items: [user, tool("read"), tool("read"), tool("shell")] }, live)?.action)
      .toBe("Reading code • Reading code • Running command");
    const thought: TranscriptItem = { type: "message", id: "t", role: "thought", text: "", attachments: [], startedAtMs: 1 };
    expect(composerActivity({ items: [user, thought, tool("read")] }, live)?.action)
      .toBe("Thinking • Reading code");
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
