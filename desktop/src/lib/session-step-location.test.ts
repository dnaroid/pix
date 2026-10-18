import { describe, expect, it } from "vitest";
import { activityGroupIdFor, locateSessionStepStart } from "./session-step-location";
import type { MessageItem, ToolItem, TranscriptItem } from "./transcript-types";

function todo(id: string, rawInput: unknown, status: ToolItem["status"] = "completed"): ToolItem {
  return { type: "tool", id, toolCallId: id, name: "todo", title: "todo", kind: "other", status, rawInput, content: "", diffs: [], attachments: [] };
}
function user(id: string): MessageItem {
  return { type: "message", id, role: "user", text: "go", attachments: [] };
}
const step = { id: 2, subject: "Write tests" };

describe("locateSessionStepStart", () => {
  it("prefers the newest call that set the step in_progress", () => {
    const items: TranscriptItem[] = [
      todo("c", { action: "batch_create", replace: true, items: [{ subject: "Plan" }, { subject: "Write tests" }] }),
      todo("u1", { action: "update", id: 2, status: "in_progress" }),
      todo("u2", { action: "batch_update", items: [{ id: 1, status: "completed" }, { id: 2, status: "in_progress" }] }),
      todo("u3", { action: "update", id: 2, status: "completed" }),
    ];
    expect(locateSessionStepStart(items, step)).toEqual({ kind: "found", itemId: "u2" });
  });

  it("falls back to the creating call and ignores failed calls", () => {
    const items: TranscriptItem[] = [
      todo("c", { action: "batch_create", replace: true, items: [{ subject: "Plan" }, { subject: "Write tests" }] }),
      todo("bad", { action: "update", id: 2, status: "in_progress" }, "failed"),
    ];
    expect(locateSessionStepStart(items, step)).toEqual({ kind: "found", itemId: "c" });
    expect(locateSessionStepStart([todo("one", { action: "create", subject: "Write tests" })], step))
      .toEqual({ kind: "found", itemId: "one" });
  });

  it("stops at a replacing plan or clear boundary instead of matching a superseded plan", () => {
    const items: TranscriptItem[] = [
      todo("old", { action: "update", id: 2, status: "in_progress" }),
      todo("replace", { action: "batch_create", replace: true, items: [{ subject: "Other" }, { subject: "Different" }] }),
    ];
    expect(locateSessionStepStart(items, step)).toEqual({ kind: "missing" });
    expect(locateSessionStepStart([todo("old", { action: "update", id: 2, status: "in_progress" }), todo("clear", { action: "clear" })], step))
      .toEqual({ kind: "missing" });
  });

  it("asks for older history when no boundary is loaded", () => {
    expect(locateSessionStepStart([user("m"), todo("u", { action: "update", id: 1, status: "in_progress" })], step))
      .toEqual({ kind: "older" });
  });

  it("maps a tool to its collapsed activity group id", () => {
    const items: TranscriptItem[] = [user("m"), todo("a", {}), todo("b", {})];
    expect(activityGroupIdFor(items, "b")).toBe("activity-group:a");
    expect(activityGroupIdFor(items, "m")).toBeUndefined();
  });
});
