import { describe, expect, test } from "bun:test";

import { rehydrateToolRecordsFromMessages } from "../src/dcp/recovery.js";
import { createState } from "../src/dcp/state.js";

describe("DCP ephemeral tool-record recovery", () => {
  test("rebuilds protection metadata from raw history without inventing provider evidence", () => {
    const state = createState();
    const messages = [
      { id: "u1", role: "user", timestamp: 1, content: "inspect the config" },
      {
        id: "a1",
        role: "assistant",
        timestamp: 2,
        content: [{ type: "toolCall", id: "call-read", name: "read", input: { path: "src/config.ts" } }],
      },
      {
        id: "r1",
        role: "toolResult",
        toolCallId: "call-read",
        toolName: "read",
        timestamp: 3,
        isError: false,
        content: [{ type: "text", text: "exact recovered output" }],
        details: { source: "raw-session" },
      },
    ];

    const first = rehydrateToolRecordsFromMessages(messages, state);
    expect(first).toEqual({ recordsUpdated: 1, exactArgsRestored: 1, exactOutputsRestored: 1 });
    expect(state.toolCalls.size).toBe(1);
    expect(state.totalToolCallCount).toBe(1);
    expect(state.toolCalls.get("call-read")).toMatchObject({
      toolCallId: "call-read",
      toolName: "read",
      inputArgs: { path: "src/config.ts" },
      turnIndex: 1,
      timestamp: 3,
      outputText: "exact recovered output",
      outputDetails: { source: "raw-session" },
    });
    expect(state.toolCalls.get("call-read")?.inputFingerprint).toMatch(/^read::sha256:/);
    expect(state.providerSeenToolIds.size).toBe(0);

    const second = rehydrateToolRecordsFromMessages(messages, state);
    expect(second).toEqual({ recordsUpdated: 0, exactArgsRestored: 0, exactOutputsRestored: 0 });
    expect(state.toolCalls.size).toBe(1);
    expect(state.providerSeenToolIds.size).toBe(0);
  });
});
