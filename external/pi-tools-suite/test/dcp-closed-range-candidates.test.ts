import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/dcp/config.js";
import { registerCompressTool } from "../src/dcp/compress-tool.js";
import { closeConversationRange } from "../src/dcp/conversation-index.js";
import { applyPruning, detectCompressionCandidate } from "../src/dcp/pruner.js";
import { createState } from "../src/dcp/state.js";

function text(role: string, content: string) {
  return { role, content: [{ type: "text", text: content }] };
}

function call(...ids: string[]) {
  return { role: "assistant", content: ids.map((id) => ({
    type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` },
  })) };
}

function result(id: string) {
  return { ...text("toolResult", `Decision: preserve ${id}.\n${"old inspection output\n".repeat(100)}`),
    toolCallId: id, toolName: "read", isError: false };
}

function fixture(raw: any[], minMessages = 2) {
  const config = loadConfig({ homeDir: "/__dcp_closed_range_test__" });
  config.debug = false;
  for (const strategy of Object.values(config.strategies)) strategy.enabled = false;
  Object.assign(config.compress.autoCandidates, {
    enabled: true, minContextPercent: 0, keepRecentTurns: 1, minMessages, minTokens: 1,
  });
  const state = createState();
  const messages = applyPruning(raw.map((message, index) => ({
    ...message, id: `entry-${index}`, timestamp: index + 1,
  })), state, config);
  return { config, state, messages };
}

function interruptedHistory() {
  return [
    text("user", "old task"), call("before"), result("before"),
    call("missing-wait-result"),
    text("user", "continue after restart"), call("after"), result("after"),
    text("assistant", "completed resumed work"),
    text("user", "active request: do not compress this turn"),
  ];
}

describe("DCP closed range recommendations", () => {
  test.each([undefined, { requiredSavingsTokens: 10 }, { requiredSavingsTokens: 100_000 }])(
    "skips the historical incomplete group with planning options %j", (options: { requiredSavingsTokens: number } | undefined) => {
      const { messages, state, config } = fixture(interruptedHistory());
      const candidate = detectCompressionCandidate(messages, state, config, 0.5, options);
      expect(candidate).toMatchObject({ startId: "m001", endId: "m003" });
      expect(closeConversationRange(state.conversationIndexSnapshot, candidate!.startId, candidate!.endId))
        .toMatchObject({ expanded: false, incompleteToolGroup: false });
    },
  );

  test("a too-small prefix does not starve the closed work after an interrupted call", () => {
    const { messages, state, config } = fixture(interruptedHistory(), 4);
    for (const options of [undefined, { requiredSavingsTokens: 100_000 }]) {
      expect(detectCompressionCandidate(messages, state, config, 0.5, options))
        .toMatchObject({ startId: "m005", endId: "m008", messageCount: 4 });
    }
  });

  test("a partial parallel result group is excluded, not mistaken for a closed suffix", () => {
    const { messages, state, config } = fixture([
      call("missing-a", "present-b"), result("present-b"),
      text("user", "resumed"), call("done"), result("done"),
      call("missing-tail"), text("user", "active"),
    ]);
    expect(detectCompressionCandidate(messages, state, config, 0.5))
      .toMatchObject({ startId: "m003", endId: "m005" });
  });

  test("returns no range when every eligible slice is incomplete or too small", () => {
    const { messages, state, config } = fixture([
      call("missing-a", "present-b"), result("present-b"),
      text("assistant", "tiny"), call("missing-tail"), text("user", "active"),
    ]);
    expect(detectCompressionCandidate(messages, state, config, 0.5)).toBeNull();
  });

  test("budget sizing still closes all parallel results without entering the active turn", () => {
    const { messages, state, config } = fixture([
      text("user", "old task"), call("a", "b"), result("a"), result("b"),
      text("assistant", "completed"), text("user", "active"),
    ]);
    expect(detectCompressionCandidate(messages, state, config, 0.5))
      .toMatchObject({ startId: "m001", endId: "m005" });
    expect(detectCompressionCandidate(messages, state, config, 0.5, { requiredSavingsTokens: 1 }))
      .toMatchObject({ startId: "m001", endId: "m004" });
  });

  test("a rejected stale suggestion identifies the missing result and closed alternatives without mutation", async () => {
    const { state, config } = fixture(interruptedHistory());
    let tool: any;
    registerCompressTool({ registerTool(value: any) { tool = value; } } as any, state, config);
    const before = JSON.stringify(state.conversationIndexSnapshot);
    const nextBlockId = state.nextBlockId;
    let error: unknown;
    try {
      await tool.execute("stale-suggestion", {
        topic: "Old work", ranges: [{ startId: "m001", endId: "m008", summary: "completed work" }],
      }, undefined, undefined, { ui: { notify() {} } });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    const message = String(error);
    expect(message).toContain("incomplete tool group");
    expect(message).toContain("m004");
    expect(message).toContain("missing-wait-result");
    expect(message).toContain("m001..m003");
    expect(message).toContain("m005..m008");
    expect(message).not.toContain("Wait until");
    expect(state.compressionBlocks).toHaveLength(0);
    expect(state.nextBlockId).toBe(nextBlockId);
    expect(JSON.stringify(state.conversationIndexSnapshot)).toBe(before);
  });
});
