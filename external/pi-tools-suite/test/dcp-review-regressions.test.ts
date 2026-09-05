import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/dcp/config.js";
import { createState, resetState, restoreState } from "../src/dcp/state.js";
import { applyPruning, detectEmergencyCompressionCandidate } from "../src/dcp/pruner.js";
import { registerCompressTool } from "../src/dcp/compress-tool.js";
import {
  buildSummarySourceManifest, hashSummarySourceManifest, createAutoCompressionBlock,
} from "../src/dcp/auto-compress.js";
import { applyCompressionBlocks } from "../src/dcp/pruner-compression-blocks.js";
import { createBudgetedAutoCompressionBlock } from "../src/dcp/auto-compress-budget.js";
import { loadDcpState, saveDcpState, resetDcpPersistenceDedup } from "../src/dcp/state-persistence.js";

function fixture() {
  const config = loadConfig({ homeDir: "/__dcp_review_no_config__" });
  config.debug = false;
  config.strategies.deduplication.enabled = false;
  config.strategies.autoToolPruning.enabled = false;
  config.strategies.purgeErrors.enabled = false;
  config.compress.autoCompress = { enabled: true, patience: 0, summarizerModel: [], timeoutMs: 1000 };
  config.compress.autoCandidates.minMessages = 2;
  config.compress.autoCandidates.minTokens = 100;
  return { state: createState(), config };
}
const text = (id: string, timestamp: number, value: string, role = "assistant"): any =>
  ({ id, role, timestamp, content: [{ type: "text", text: value }] });
const large = (id: string, timestamp: number) => text(id, timestamp, "log line\n".repeat(900));
function candidate(state: ReturnType<typeof createState>, start: string, end: string) {
  return {
    startId: state.messageIdsByStableId.get(`id:${start}`)!,
    endId: state.messageIdsByStableId.get(`id:${end}`)!,
    messageCount: 3, estimatedTokens: 4000, includedBlockIds: [], reason: "review regression",
  };
}
function toolFor(state: ReturnType<typeof createState>, config: ReturnType<typeof loadConfig>, dependencies?: any): any {
  let tool: any;
  registerCompressTool({ registerTool(value: any) { tool = value; } } as any, state, config, dependencies);
  return tool;
}
const ctx: any = { sessionManager: {}, ui: { notify() {} } };

describe("DCP independent review regressions", () => {
  test("config instances do not share mutable nested defaults", () => {
    const original = loadConfig({ homeDir: "/__dcp_review_no_config__" });
    const modified = loadConfig({ homeDir: "/__dcp_review_no_config__" });
    modified.compress.autoCandidates.minMessages = 999;
    modified.compress.protectedTools.push("fixture-only-tool");
    expect(loadConfig({ homeDir: "/__dcp_review_no_config__" })).toEqual(original);
  });
  test("net budget recovery expands an insufficient prefix under the same safety policy", async () => {
    const { state, config } = fixture();
    config.compress.autoCompress.timeoutMs = 10000;
    const raw = [text("user", 1, "Do not change public API", "user")];
    for (let i = 0; i < 100; i++) {
      const id = `call-${i}`;
      raw.push({ id: `a-${i}`, role: "assistant", timestamp: 2 + i * 2, content: [{ type: "toolCall", id, name: "read", arguments: { path: `file-${i}.ts` } }] });
      raw.push({ id: `t-${i}`, role: "toolResult", toolCallId: id, toolName: "read", timestamp: 3 + i * 2, content: [{ type: "text", text: "log\n".repeat(500) }], isError: false });
      state.providerSeenToolIds.add(id);
    }
    const projected = applyPruning(raw, state, config);
    const required = 1500;
    const minimal = detectEmergencyCompressionCandidate(projected, state, config, 0.9, 0.65, { requiredSavingsTokens: required });
    const largest = detectEmergencyCompressionCandidate(projected, state, config, 0.9, 0.65);
    expect(minimal).not.toBeNull(); expect(largest).not.toBeNull();
    const result = await createBudgetedAutoCompressionBlock({
      state, config, messages: projected, candidate: minimal!, requiredGainTokens: required, topic: "budget recovery",
    }, largest);
    expect(result.projectedGain).toBeGreaterThanOrEqual(required);
    expect(state.compressionBlocks).toHaveLength(1);
  });
  test("summary covers physical membership even when timestamps move backwards", async () => {
    const { state, config } = fixture();
    const raw = [large("a", 10), text("middle", 100, "Decision: KEEP_MIDDLE_CONSTRAINT"), large("b", 20), text("carrier", 101, "continue", "user")];
    const projected = applyPruning(raw, state, config);
    await createAutoCompressionBlock({ state, config, messages: projected, candidate: candidate(state, "a", "b"), topic: "review" });
    expect(state.compressionBlocks[0]?.summary).toContain("KEEP_MIDDLE_CONSTRAINT");
    expect(state.compressionBlocks[0]?.sourceCoverage?.itemCount).toBe(3);
  });

  test("missing modern boundary never substitutes unrelated same-timestamp content", async () => {
    const { state, config } = fixture();
    const raw = [large("a", 10), large("b", 20), text("live", 20, "UNSELECTED_LIVE_FACT"), text("carrier", 30, "continue", "user")];
    const projected = applyPruning(raw, state, config);
    await createAutoCompressionBlock({ state, config, messages: projected, candidate: candidate(state, "a", "b"), topic: "review" });
    const changed = structuredClone(raw.filter((message) => message.id !== "b"));
    applyCompressionBlocks(changed, state);
    expect(JSON.stringify(changed)).toContain("UNSELECTED_LIVE_FACT");
  });

  test("message mode refuses actual SDK textSignature", async () => {
    const { state, config } = fixture();
    const signed = text("signed", 1, "unchanged signed answer");
    signed.content[0].textSignature = "provider-signature";
    applyPruning([signed, text("carrier", 2, "continue", "user")], state, config);
    const messageId = state.messageIdsByStableId.get("id:signed")!;
    expect(state.conversationIndexSnapshot[0]?.signedAssistant).toBe(true);
    await expect(toolFor(state, config).execute("signed-op", { topic: "signed", messages: [{ messageId, summary: "replacement" }] }, undefined, undefined, ctx)).rejects.toThrow();
    expect(state.compressionBlocks).toHaveLength(0);
    expect(signed.content[0].textSignature).toBe("provider-signature");
  });

  test("already-aborted manual and automatic operations never publish", async () => {
    for (const mode of ["manual", "auto"]) {
      const { state, config } = fixture();
      const projected = applyPruning([large("a", 1), large("b", 2), text("carrier", 3, "next", "user")], state, config);
      const selection = candidate(state, "a", "b");
      const abort = new AbortController(); abort.abort();
      let writes = 0;
      const operation = mode === "auto"
        ? createAutoCompressionBlock({ state, config, candidate: selection, messages: projected, signal: abort.signal, topic: "cancel", persistState: async () => { writes++; } })
        : toolFor(state, config, { capturePersistenceTarget: () => ({ statePath: "/not-used" }), saveStateToTarget: async () => { writes++; } })
          .execute("cancel-op", { topic: "cancel", ranges: [{ ...selection, summary: "summary" }] }, abort.signal, undefined, ctx);
      await expect(operation).rejects.toThrow();
      expect(writes).toBe(0);
      expect(state.compressionBlocks).toHaveLength(0);
      expect(state.nextBlockId).toBe(1);
    }
  });

  test("parallel successful compress calls retain distinct blocks", async () => {
    const { state, config } = fixture();
    applyPruning([large("a", 1), large("b", 2), large("c", 3), large("d", 4), text("carrier", 5, "next", "user")], state, config);
    const tool = toolFor(state, config);
    const calls = [["a", "b"], ["c", "d"]].map(([start, end], i) => tool.execute(`parallel-${i}`, {
      topic: `operation-${i}`, ranges: [{ ...candidate(state, start!, end!), summary: `summary-${i}` }],
    }, undefined, undefined, ctx));
    const results = await Promise.allSettled(calls);
    const successes = results.filter((result) => result.status === "fulfilled");
    expect(successes.length).toBeGreaterThan(0);
    expect(state.compressionBlocks.length).toBe(successes.length);
    expect(new Set(state.compressionBlocks.map((block) => block.id)).size).toBe(successes.length);
  });

  test("source middle is preserved and changes the full source hash", () => {
    const message = (fact: string) => text("source", 1, "prefix\n".repeat(800) + `Decision: ${fact}\n` + "suffix\n".repeat(800));
    const left = buildSummarySourceManifest([message("CRITICAL_ALPHA")]);
    const right = buildSummarySourceManifest([message("CRITICAL_BRAVO")]);
    expect(JSON.stringify(left)).toContain("CRITICAL_ALPHA");
    expect(hashSummarySourceManifest(left)).not.toBe(hashSummarySourceManifest(right));
  });

  test("quarantine blocks empty overwrite across a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dcp-corrupt-review-"));
    const context: any = { sessionManager: { getSessionDir: () => dir, getSessionId: () => "broken" } };
    try {
      await mkdir(join(dir, "dcp-state"));
      await writeFile(join(dir, "dcp-state/broken.json"), "broken-json");
      resetDcpPersistenceDedup();
      await loadDcpState(context);
      await expect(saveDcpState(context, createState())).rejects.toThrow();
      resetDcpPersistenceDedup();
      await loadDcpState(context);
      await expect(saveDcpState(context, createState())).rejects.toThrow();
    } finally { resetDcpPersistenceDedup(); await rm(dir, { recursive: true, force: true }); }
  });

  test("independent stale state owner cannot overwrite a newer durable revision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dcp-cas-review-"));
    const context: any = { sessionManager: { getSessionDir: () => dir, getSessionId: () => "cas" } };
    try {
      resetDcpPersistenceDedup();
      const initial = createState(); await saveDcpState(context, initial);
      const a = createState(); restoreState(a, await loadDcpState(context));
      const b = createState(); restoreState(b, await loadDcpState(context));
      b.totalPruneCount = 42; await saveDcpState(context, b);
      a.nudgeCounter = 7;
      await expect(saveDcpState(context, a)).rejects.toThrow(/conflict|stale|revision/i);
      const document = JSON.parse(await readFile(join(dir, "dcp-state/cas.json"), "utf8"));
      expect(document.payload.totalPruneCount).toBe(42);
    } finally { resetDcpPersistenceDedup(); await rm(dir, { recursive: true, force: true }); }
  });
});
