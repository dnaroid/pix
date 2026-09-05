import { describe, expect, test } from "bun:test";
import dcpModule from "../src/dcp/index.js";
import { loadConfig } from "../src/dcp/config.js";
import { createState, restoreState, serializeState } from "../src/dcp/state.js";
import { applyPruning } from "../src/dcp/pruner.js";
import { estimateMessageTokens } from "../src/dcp/pruner-metadata.js";

describe("DCP full lifecycle marathon", () => {
  test("provider completions drive repeated budget-sufficient compression and preserve retired facts", async () => {
    const config = loadConfig({ homeDir: "/__dcp_lifecycle_fixture__" });
    config.debug = false;
    config.compress.maxContextPercent = 0.55;
    config.compress.minContextPercent = 0.10;
    config.compress.summaryBuffer = false;
    config.compress.autoCompress = { enabled: true, patience: 0, summarizerModel: [], timeoutMs: 10000 };
    config.compress.autoCandidates.minMessages = 2;
    config.compress.autoCandidates.minTokens = 100;
    config.strategies.deduplication.enabled = false;
    config.strategies.purgeErrors.enabled = false;
    config.strategies.autoToolPruning.enabled = false;
    config.strategies.emergencyCurrentTurnPruning.keepRecentToolPairs = 2;
    config.strategies.emergencyCurrentTurnPruning.patience = 10000;
    const state = createState();
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const pi: any = {
      on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      registerTool() {}, registerCommand() {}, appendEntry() {}, sendMessage() {},
    };
    let nativeTokens = 0;
    let aborted = false;
    const context: any = {
      model: { provider: "fixture", id: "main", contextWindow: 16000, maxTokens: 1000 },
      sessionManager: { getBranch: () => [] },
      getContextUsage: () => ({ tokens: nativeTokens, contextWindow: 16000 }),
      abort() { aborted = true; },
      ui: { notify() {} },
    };
    const emit = async (name: string, event: any) => {
      let result: any;
      for (const handler of handlers.get(name) ?? []) result = await handler(event, context);
      return result;
    };
    await dcpModule(pi, { config, state });
    const raw: any[] = [{ id: "task", role: "user", timestamp: 1, content: "Keep the public API unchanged." }];
    const facts: string[] = [];
    let committed = 0;
    for (let index = 0; index < 160; index++) {
      const beforeBlocks = state.nextBlockId;
      const projected = (await emit("context", { type: "context", messages: raw })).messages;
      if (state.nextBlockId > beforeBlocks) {
        committed++;
        const view = JSON.stringify(projected);
        for (const fact of facts) expect(view).toContain(fact);
      }
      nativeTokens = projected.reduce((sum: number, message: any) => sum + estimateMessageTokens(message), 0);
      await emit("before_provider_request", { payload: { messages: projected } });
      await emit("after_provider_response", { status: 200, headers: {} });
      const callId = `call-${index}`;
      const assistant: any = {
        id: `assistant-${index}`, role: "assistant", provider: "fixture", model: "main", stopReason: "toolUse",
        timestamp: 2 + index * 2, content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: `fixture-${index}.txt` } }],
      };
      raw.push(assistant);
      await emit("message_end", { message: assistant });
      await emit("tool_call", { toolCallId: callId, toolName: "read", input: { path: `fixture-${index}.txt` } });
      const fact = index % 16 === 0 ? `RETIRED_FACT_${index}_KEEP_LOCKING` : undefined;
      if (fact) facts.push(fact);
      const result: any = {
        id: `result-${index}`, role: "toolResult", toolCallId: callId, toolName: "read", isError: false,
        timestamp: 3 + index * 2,
        content: [{ type: "text", text: `${fact ? `Decision: ${fact}\n` : ""}${"log line\n".repeat(450)}` }],
      };
      raw.push(result);
      await emit("tool_result", result);
      expect(aborted).toBe(false);
    }
    expect(committed).toBeGreaterThanOrEqual(10);
    expect(state.providerSeenToolIds.size).toBeGreaterThan(100);
    const restored = createState();
    restoreState(restored, serializeState(state));
    const afterRestart = applyPruning(raw, restored, config);
    for (const fact of facts) expect(JSON.stringify(afterRestart)).toContain(fact);
    expect(raw.filter((message) => message.role === "user")).toHaveLength(1);
  }, 60000);
});
