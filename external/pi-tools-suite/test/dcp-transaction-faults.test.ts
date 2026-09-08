import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/dcp/config.js";
import { createState } from "../src/dcp/state.js";
import { applyPruning } from "../src/dcp/pruner.js";
import { createAutoCompressionBlock } from "../src/dcp/auto-compress.js";
import { registerCompressTool } from "../src/dcp/compress-tool.js";
import { registerCommands } from "../src/dcp/commands.js";

function fixture() {
  const config = loadConfig({ homeDir: "/__dcp_fault_fixture__" });
  config.debug = false;
  config.compress.autoCompress = { enabled: true, patience: 0, summarizerModel: [], timeoutMs: 1000 };
  const state = createState();
  const raw: any[] = [
    { id: "a", role: "assistant", timestamp: 1, content: [{ type: "text", text: "source\n".repeat(1000) }] },
    { id: "b", role: "assistant", timestamp: 2, content: [{ type: "text", text: "Decision: preserve lock order\n" + "log\n".repeat(1000) }] },
    { id: "u", role: "user", timestamp: 3, content: "continue" },
  ];
  const messages = applyPruning(raw, state, config);
  const candidate = { startId: "m001", endId: "m002", messageCount: 2, estimatedTokens: 2500, includedBlockIds: [], reason: "fault fixture" };
  return { state, config, raw, messages, candidate };
}

function context(dir: string, id = "session"): any {
  return { sessionManager: { getSessionDir: () => dir, getSessionId: () => id }, ui: { notify() {} } };
}

describe("DCP transaction fault boundaries", () => {
  test("a changed source during the model await cannot reach persistence", async () => {
    const data = fixture();
    data.config.compress.autoCompress.summarizerModel = ["fixture/summary"];
    let writes = 0;
    const registry = {
      find: () => ({ provider: "fixture", id: "summary", api: "openai-completions", contextWindow: 32000, maxTokens: 2000 }),
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: async () => {
        await Promise.resolve();
        data.messages[0].content[0].text = "CHANGED_SOURCE_AFTER_PLAN";
        return { content: [{ type: "text", text: "old summary" }], stopReason: "stop" };
      },
    };
    await expect(createAutoCompressionBlock({ ...data, topic: "stale", modelRegistry: registry, persistState: async () => { writes++; } })).rejects.toThrow(/stale_plan/);
    expect(writes).toBe(0);
    expect(data.state.compressionBlocks).toHaveLength(0);
  });

  test("same tool-call id with changed parameters is a conflict, not an idempotent success", async () => {
    const { state, config, candidate } = fixture();
    let tool: any;
    registerCompressTool({ registerTool(value: any) { tool = value; } } as any, state, config);
    const args = { topic: "first", ranges: [{ ...candidate, summary: "first summary" }] };
    await tool.execute("same-call", args, undefined, undefined, { sessionManager: {} });
    await expect(tool.execute("same-call", { ...args, topic: "different" }, undefined, undefined, { sessionManager: {} })).rejects.toThrow(/identity conflict/i);
    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks[0]?.topic).toBe("first");
  });

  test("new interior content is not deleted by a previously committed exact block", async () => {
    const data = fixture();
    await createAutoCompressionBlock({ ...data, topic: "exact" });
    data.raw.splice(1, 0, { id: "new", role: "assistant", timestamp: 1, content: "UNPLANNED_INTERIOR_FACT" });
    const projected = applyPruning(data.raw, data.state, data.config);
    expect(JSON.stringify(projected)).toContain("UNPLANNED_INTERIOR_FACT");
  });

  test("failed command persistence neither mutates manual mode nor reports success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dcp-command-fault-"));
    try {
      const { state, config } = fixture();
      let command: any;
      registerCommands(
        { registerCommand(_name: string, value: any) { command = value; } } as any,
        state,
        config,
        { persistState: async () => { throw new Error("journal writer failed"); } },
      );
      const notifications: string[] = [];
      const ctx = context(dir);
      ctx.ui.notify = (text: string) => { notifications.push(text); };
      await expect(command.handler("manual on", ctx)).rejects.toThrow(/journal writer/i);
      expect(state.manualMode).toBe(false);
      expect(notifications).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
