import { describe, expect, it } from "vitest";
import { loadedSessionSkills } from "./session-skills";
import type { MessageItem, ToolItem } from "./transcript-types";

function tool(skillName: string | undefined, status: ToolItem["status"]): ToolItem {
  return {
    type: "tool", id: "tool", toolCallId: "tool", title: "Read", kind: "read",
    skillName, status, content: "", diffs: [], attachments: [],
  };
}

function user(text: string, localOnly = false): MessageItem {
  return { type: "message", id: "user", role: "user", text, localOnly, attachments: [] };
}

describe("loadedSessionSkills", () => {
  const expanded = '<skill name="demo" location="/skills/demo/SKILL.md">\nInstructions\n</skill>\n\nUser request';

  it("lists successful reads and expanded commands once, in transcript order", () => {
    expect(loadedSessionSkills([
      tool("first", "completed"), user(expanded), tool("demo", "completed"),
      tool("first", "completed"), tool("last", "completed"),
    ])).toEqual(["first", "demo", "last"]);
  });

  it("ignores pending or failed reads, unexpanded commands, and locally queued text", () => {
    expect(loadedSessionSkills([
      tool("pending", "pending"), tool("running", "in_progress"), tool("failed", "failed"),
      tool(undefined, "completed"), user("/skill:demo"), user(expanded, true),
      user(expanded.slice(0, expanded.indexOf("\n</skill>"))), { ...user(expanded), role: "assistant" },
    ])).toEqual([]);
  });
});
