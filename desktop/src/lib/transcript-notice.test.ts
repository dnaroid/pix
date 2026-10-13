import { describe, expect, it } from "vitest";
import { transcriptNotice } from "./transcript-notice";
import { applySessionUpdates, emptyTranscript, groupTranscriptItems } from "./transcript";
import transcriptSource from "../components/TranscriptPane.svelte?raw";

describe("transcript notices", () => {
  it("distinguishes nonfatal warnings, extension errors and stopped agents", () => {
    expect(transcriptNotice("pix-system:notification:warning:1", "97% used"))
      .toEqual({ title: "Warning", severity: "warning" });
    expect(transcriptNotice("pix-system:notification:error:1", "Login required"))
      .toEqual({ title: "Extension error", severity: "error" });
    expect(transcriptNotice("pix-system:error:1", "WebSocket closed 1012"))
      .toEqual({ title: "Agent stopped with an error", severity: "error" });
  });

  it("styles only exact legacy Claude rate-limit system notices", () => {
    const text = "[pi-claude-code-provider] Claude rate limit warning: 97% used (five_hour)";
    expect(transcriptNotice("pix-system:old", text)?.severity).toBe("warning");
    expect(transcriptNotice("assistant:1", text)).toBeUndefined();
    expect(transcriptNotice(undefined, text)).toBeUndefined();
    expect(transcriptNotice("pix-system:1", "Reloaded resources")).toBeUndefined();
    expect(transcriptNotice("pix-system:1", "Some warning text")).toBeUndefined();
  });

  it("keeps warning rows visible between activity and continued assistant output", () => {
    const text = "97% used; resets at 7:10 PM";
    const state = applySessionUpdates(emptyTranscript, [
      { sessionUpdate: "agent_thought_chunk", messageId: "thinking", content: { type: "text", text: "Working" } },
      { sessionUpdate: "agent_message_chunk", messageId: "pix-system:notification:warning:1", content: { type: "text", text } },
      { sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "Continuing" } },
    ]);
    expect(state.items[1]).toMatchObject({ role: "system", text });
    expect(groupTranscriptItems(state.items).map((item) => item.type)).toEqual(["activity-group", "message", "message"]);
  });

  it("uses the existing compact error-card geometry with warning theme roles", () => {
    expect(transcriptSource).toContain("transcriptNotice(item.messageId, item.text)");
    expect(transcriptSource).toContain("gap-2.5 rounded-sm border-l-[3px] bg-panel-strong px-3 py-2 text-xs");
    expect(transcriptSource).toContain('notice.severity === "warning" ? "border-tool-warning" : "border-tool-error"');
    expect(transcriptSource).toContain('notice.severity === "warning" ? "text-tool-warning" : "text-tool-error"');
    expect(transcriptSource).toContain('role={notice.severity === "warning" ? "status" : "alert"}');
    expect(transcriptSource).toContain("{notice.title}");
  });
});
