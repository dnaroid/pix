import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/dcp/config.js";
import { createState, resetState, restoreState } from "../src/dcp/state.js";
import { applyPruning } from "../src/dcp/pruner.js";
import { createAutoCompressionBlock } from "../src/dcp/auto-compress.js";
import { registerCompressTool } from "../src/dcp/compress-tool.js";
import { registerCommands } from "../src/dcp/commands.js";
import { loadDcpState, saveDcpState, saveDcpStateToTarget, resetDcpPersistenceDedup } from "../src/dcp/state-persistence.js";

function fixture() {
  const config = loadConfig({ homeDir: "/__dcp_fault_fixture__" });
  config.debug = false;
  config.strategies.deduplication.enabled = false;
  config.strategies.autoToolPruning.enabled = false;
  config.strategies.purgeErrors.enabled = false;
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
  test("a completed second-process writer is not overwritten by a stale first owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dcp-multiprocess-cas-"));
    try {
      const ctx = context(dir);
      const a = createState();
      await saveDcpState(ctx, a);
      restoreState(a, await loadDcpState(ctx));
      const persistenceUrl = new URL("../src/dcp/state-persistence.ts", import.meta.url).href;
      const stateUrl = new URL("../src/dcp/state.ts", import.meta.url).href;
      const script = `
        const {createState,restoreState} = await import(${JSON.stringify(stateUrl)});
        const {loadDcpState,saveDcpState} = await import(${JSON.stringify(persistenceUrl)});
        const ctx={sessionManager:{getSessionDir:()=>${JSON.stringify(dir)},getSessionId:()=>"session"}};
        const b=createState(); restoreState(b,await loadDcpState(ctx));
        b.totalPruneCount=42; await saveDcpState(ctx,b);
      `;
      const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += String(data); });
      const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      a.nudgeCounter = 9;
      await expect(saveDcpState(ctx, a)).rejects.toThrow(/stale.*revision/i);
      const disk = JSON.parse(await readFile(join(dir, "dcp-state/session.json"), "utf8"));
      expect(disk.generation).toBe(2);
      expect(disk.payload.totalPruneCount).toBe(42);
    } finally { resetDcpPersistenceDedup(); await rm(dir, { recursive: true, force: true }); }
  });

  test("publication cancellation leaves the primary generation unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dcp-publication-cancel-"));
    try {
      const state = createState();
      const ctx = context(dir);
      await saveDcpState(ctx, state);
      const path = join(dir, "dcp-state/session.json");
      const before = await readFile(path, "utf8");
      state.nudgeCounter++;
      let checkpoints = 0;
      await expect(saveDcpStateToTarget({ statePath: path, sessionId: "session" }, state, {
        beforePublish: () => { if (++checkpoints === 4) throw new Error("cancel at publication"); },
      })).rejects.toThrow("cancel at publication");
      expect(await readFile(path, "utf8")).toBe(before);
      expect(checkpoints).toBe(4);
    } finally { resetDcpPersistenceDedup(); await rm(dir, { recursive: true, force: true }); }
  });

  test("an exception after rename is reconciled as a committed generation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dcp-post-publication-"));
    try {
      const state = createState();
      state.nudgeCounter = 7;
      const path = join(dir, "dcp-state/session.json");
      await saveDcpStateToTarget({ statePath: path, sessionId: "session" }, state, {
        onPublished: () => { throw new Error("post-rename diagnostic failure"); },
      });
      const disk = JSON.parse(await readFile(path, "utf8"));
      expect(disk.payload.nudgeCounter).toBe(7);
      expect(disk.generation).toBe(1);
      await saveDcpState(context(dir), state);
      expect(JSON.parse(await readFile(path, "utf8")).generation).toBe(1);
    } finally { resetDcpPersistenceDedup(); await rm(dir, { recursive: true, force: true }); }
  });

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
      registerCommands({ registerCommand(_name: string, value: any) { command = value; } } as any, state, config);
      const notifications: string[] = [];
      const ctx = context(dir);
      ctx.ui.notify = (text: string) => { notifications.push(text); };
      await mkdir(join(dir, "dcp-state"));
      await writeFile(join(dir, "dcp-state/session.json.lock"), "fixture lock");
      await expect(command.handler("manual on", ctx)).rejects.toThrow(/writer/i);
      expect(state.manualMode).toBe(false);
      expect(notifications).toEqual([]);
    } finally { resetDcpPersistenceDedup(); await rm(dir, { recursive: true, force: true }); }
  });
});
