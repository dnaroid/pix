import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/dcp/config.js";
import { applyPruning } from "../src/dcp/pruner.js";
import { createState } from "../src/dcp/state.js";

function transcript(): any[] {
  return [
    { role: "user", content: "Investigate.", timestamp: 1 },
    { role: "assistant", timestamp: 2, content: [{ type: "text", text: "analysis ".repeat(1_000) }, { type: "toolCall", id: "read-big", name: "read", arguments: { path: "big.ts" } }] },
    { role: "toolResult", toolCallId: "read-big", toolName: "read", isError: false, timestamp: 3, content: [{ type: "text", text: "line of code\n".repeat(1_200) }] },
    { role: "assistant", timestamp: 4, content: [{ type: "toolCall", id: "read-small", name: "read", arguments: { path: "small.ts" } }] },
    { role: "toolResult", toolCallId: "read-small", toolName: "read", isError: false, timestamp: 5, content: [{ type: "text", text: "tiny" }] },
  ];
}

function carriers(messages: any[]): string[] {
  return messages.flatMap((message) => JSON.stringify(message.content).match(/<dcp-message-ids>[^<]*<\/dcp-message-ids>/g) ?? []);
}

describe("DCP message-id size hints", () => {
  test("large messages carry a coarse ~Nk size hint; small ones stay unannotated", () => {
    const config = loadConfig({ homeDir: "/__dcp_size_hints__" });
    const ids = carriers(applyPruning(transcript(), createState(), config));
    expect(ids[1]).toMatch(/m002=a~\d+k;m003=t~\d+k</);
    expect(ids[2]).toMatch(/m004=a;m005=t</);
  });

  test("hint bytes are identical across passes and a fresh state (restart)", () => {
    const config = loadConfig({ homeDir: "/__dcp_size_hints__" });
    const state = createState();
    const first = carriers(applyPruning(transcript(), state, config));
    const second = carriers(applyPruning(transcript(), state, config));
    const restarted = carriers(applyPruning(transcript(), createState(), config));
    expect(second).toEqual(first);
    expect(restarted).toEqual(first);
  });
});
