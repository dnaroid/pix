import { describe, expect, it } from "vitest";
import { applySessionUpdate, transcriptFromSessionUpdates } from "./transcript-reducer";
import { emptyTranscript, type ToolItem } from "./transcript-types";

function first(state: ReturnType<typeof transcriptFromSessionUpdates>): ToolItem {
  return state.items[0] as ToolItem;
}

describe("image read metadata", () => {
  it.each(["read", "Read", "functions.Read"])("classifies %s arguments and retains classification on status updates", (name) => {
    const state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "a", name, title: "Read", rawInput: { file_path: "/tmp/SHOT.PNG" },
    });
    expect(first(state).imageRead).toBe(true);
    const settled = applySessionUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" });
    expect(first(settled).imageRead).toBe(true);
    const corrected = applySessionUpdate(settled, { sessionUpdate: "tool_call_update", toolCallId: "a", rawInput: { path: "README.md" } });
    expect(first(corrected).imageRead).toBe(false);
  });

  it("recognizes lightweight history titles and locations without result loading", () => {
    for (const metadata of [{ title: "Read /tmp/photo.webp" }, { title: "Read", locations: [{ path: "/tmp/photo.jpeg" }] }]) {
      expect(first(transcriptFromSessionUpdates([{
        sessionUpdate: "tool_call", toolCallId: "a", name: "Read", status: "completed", ...metadata,
      }])).imageRead).toBe(true);
    }
  });

  it("does not classify other tools or ordinary file reads as images", () => {
    for (const [name, path] of [["write", "image.png"], ["read", "README.md"], ["read", "demo/SKILL.md"]]) {
      expect(first(applySessionUpdate(emptyTranscript, {
        sessionUpdate: "tool_call", toolCallId: "a", name, title: name!, rawInput: { path },
      })).imageRead).toBe(false);
    }
  });

  it("recognizes image output for extensionless reads and clears classification on tool changes", () => {
    const state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call", toolCallId: "a", name: "read", title: "Read", rawInput: { path: "/tmp/image" },
    });
    expect(first(state).imageRead).toBe(false);
    const output = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed",
      content: [{ type: "content", content: { type: "image", data: "aGk=", mimeType: "image/png" } }],
    });
    expect(first(output).imageRead).toBe(true);
    expect(first(applySessionUpdate(output, {
      sessionUpdate: "tool_call_update", toolCallId: "a", name: "write",
    })).imageRead).toBe(false);
  });
});
