import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { parseClaudeTranscriptConfig } from "../../src/claude-code-provider/src/account-rotation.ts";
import { prepareRequest } from "../../src/claude-code-provider/src/context-serializer.ts";

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: unknown[], timestamp: number) {
  return { role: "assistant", content, api: "test", provider: "test", model: "test", usage, stopReason: "stop", timestamp };
}

function context() {
  return {
    messages: [
      { role: "user", content: "first", timestamp: 1 },
      assistant([{ type: "thinking", thinking: "old-only" }], 2),
      assistant([
        { type: "thinking", thinking: "old-with-call" },
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      ], 3),
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "r" }], isError: false, timestamp: 4 },
      assistant([{ type: "thinking", thinking: "old-answer" }, { type: "text", text: "answer" }], 5),
      { role: "user", content: "second", timestamp: 6 },
      assistant([
        { type: "thinking", thinking: "current-loop" },
        { type: "toolCall", id: "call-2", name: "read", arguments: {} },
      ], 7),
      { role: "toolResult", toolCallId: "call-2", toolName: "read", content: [{ type: "text", text: "r2" }], isError: false, timestamp: 8 },
    ],
  } as never;
}

async function records(pruneHistoricalThinking?: boolean) {
  const prepared = await prepareRequest(context(), undefined, { pruneHistoricalThinking });
  try {
    return { prepared, lines: prepared.transcriptBlocks.slice(1).map((line) => JSON.parse(line)) };
  } finally {
    await rm(prepared.directory, { recursive: true, force: true });
  }
}

describe("experimental historical thinking pruning", () => {
  test("keeps every thinking block when disabled", async () => {
    const { prepared, lines } = await records();
    expect(prepared.prunedThinkingBlocks).toBe(0);
    const text = JSON.stringify(lines);
    for (const marker of ["old-only", "old-with-call", "old-answer", "current-loop"]) expect(text).toContain(marker);
  });

  test("drops thinking before the latest user message and keeps the current tool loop", async () => {
    const { prepared, lines } = await records(true);
    expect(prepared.prunedThinkingBlocks).toBe(3);
    const text = JSON.stringify(lines);
    for (const marker of ["old-only", "old-with-call", "old-answer"]) expect(text).not.toContain(marker);
    expect(text).toContain("current-loop");
    // The thinking-only assistant message disappears; tool calls, results and text stay.
    expect(lines.map((line) => line.role)).toEqual(["user", "assistant", "toolResult", "assistant", "user", "assistant", "toolResult"]);
    expect(lines[1].content.map((block: { type: string; id?: string }) => [block.type, block.id])).toEqual([["toolCall", "call-1"]]);
    expect(lines[3].content).toEqual([{ type: "text", text: "answer" }]);
  });

  test("keeps the pruned history prefix byte-stable when the turn grows", async () => {
    const first = await records(true);
    const grown = context() as { messages: unknown[] };
    grown.messages.push(assistant([{ type: "thinking", thinking: "later" }, { type: "text", text: "done" }], 9));
    const prepared = await prepareRequest(grown as never, undefined, { pruneHistoricalThinking: true });
    try {
      expect(prepared.transcriptBlocks.slice(0, first.prepared.transcriptBlocks.length)).toEqual(first.prepared.transcriptBlocks);
    } finally {
      await rm(prepared.directory, { recursive: true, force: true });
    }
  });

  test("parses the opt-in setting", () => {
    expect(parseClaudeTranscriptConfig(undefined)).toEqual({ pruneHistoricalThinking: false });
    expect(parseClaudeTranscriptConfig({ autoRotate: true })).toEqual({ pruneHistoricalThinking: false });
    expect(parseClaudeTranscriptConfig({ pruneHistoricalThinking: true })).toEqual({ pruneHistoricalThinking: true });
    expect(() => parseClaudeTranscriptConfig({ pruneHistoricalThinking: "yes" })).toThrow(/pruneHistoricalThinking/);
    expect(() => parseClaudeTranscriptConfig([])).toThrow(/must be an object/);
  });
});
