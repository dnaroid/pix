import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/dcp/config.js";
import { createState, type DcpState } from "../src/dcp/state.js";
import { applyPruning, detectCompressionCandidate } from "../src/dcp/pruner.js";
import {
  AutoCompressionBlockedError,
  createAutoCompressionBlock,
} from "../src/dcp/auto-compress.js";
import { createBudgetedAutoCompressionBlock } from "../src/dcp/auto-compress-budget.js";
import { canonicalMessageHash } from "../src/dcp/conversation-index.js";

// ---------------------------------------------------------------------------
// Permanent regressions for two confirmed DCP auto-compression defects:
//
// 1. A v2 block created from the provider projection stored the *pruned*
//    tool-result hash in mutationMembers. On the next raw context pass
//    exactBlockSpan could never match, the block was never materialized, and
//    candidate selection repeatedly chose a partial-overlap raw range.
//
// 2. The budgeted wrapper used the same deadline as the summarizer. A slow
//    model therefore aborted the operation just as the deterministic fallback
//    was ready, surfacing as a generic "preparation failed" instead of
//    committing the fallback block.
// ---------------------------------------------------------------------------

function fixture() {
  const config = loadConfig({ homeDir: "/__dcp_projection_no_config__" });
  config.debug = false;
  config.compress.autoCompress = { enabled: true, patience: 0, summarizerModel: [], summarizerFallbackModels: [], timeoutMs: 1000 };
  config.compress.autoCandidates.minMessages = 2;
  config.compress.autoCandidates.minTokens = 100;
  return { state: createState(), config };
}

function toolRecord(toolCallId: string, toolName: string, tokenEstimate: number, turnIndex = 0) {
  return {
    toolCallId,
    toolName,
    inputArgs: {},
    inputFingerprint: `${toolName}::${toolCallId}`,
    isError: false,
    turnIndex,
    timestamp: 0,
    tokenEstimate,
  };
}

const RAW_TRACE_MARKER = "PRUNED_RAW_TRACE_MARKER";
const bigPrunedRead = `${RAW_TRACE_MARKER}\n` + "trace line\n".repeat(600);
const bigKeptAnalysis = "kept analysis detail\n".repeat(400);

function rawConversation(): any[] {
  return [
    { id: "u1", role: "user", timestamp: 1, content: [{ type: "text", text: "investigate the flaky payments test" }] },
    { id: "a1", role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "c1", name: "read", input: { path: "payments.test.ts" } }] },
    { id: "r1", role: "toolResult", toolCallId: "c1", toolName: "read", timestamp: 3, isError: false, content: [{ type: "text", text: bigPrunedRead }] },
    { id: "a2", role: "assistant", timestamp: 4, content: [{ type: "toolCall", id: "c2", name: "custom_analyze", input: { target: "flaky" } }] },
    { id: "r2", role: "toolResult", toolCallId: "c2", toolName: "custom_analyze", timestamp: 5, isError: false, content: [{ type: "text", text: bigKeptAnalysis }] },
    { id: "a3", role: "assistant", timestamp: 6, content: [{ type: "text", text: "Decision: keep the schema; retry with backoff." }] },
    // Later turns age the read output past the auto-prune policy and push the
    // range outside the protected recent-turn window.
    { id: "u2", role: "user", timestamp: 10, content: [{ type: "text", text: "turn two" }] },
    { id: "u3", role: "user", timestamp: 20, content: [{ type: "text", text: "turn three" }] },
  ];
}

function seedToolRecords(state: DcpState) {
  state.toolCalls.set("c1", toolRecord("c1", "read", 2500));
  state.toolCalls.set("c2", toolRecord("c2", "custom_analyze", 1800));
  state.providerSeenToolIds.add("c1");
  state.providerSeenToolIds.add("c2");
}

describe("DCP auto-compression projection regressions", () => {
  test("canonical message hash survives JSONL round-trip of runtime-only tool details", () => {
    const message = {
      id: "tool-result",
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "todo",
      isError: false,
      timestamp: 1,
      content: [{ type: "text", text: "ok" }],
      details: {
        tasks: [{ id: 1, blockedBy: undefined }],
        optional: undefined,
        values: ["kept", undefined, Number.NaN],
      },
    };
    const reloaded = JSON.parse(JSON.stringify(message));

    expect(canonicalMessageHash(message)).toBe(canonicalMessageHash(reloaded));
  });

  test("v2 block with JSON-normalized tool details still materializes after restart-shaped reload", async () => {
    const { state, config } = fixture();
    const raw = [
      { id: "u1", role: "user", timestamp: 1, content: [{ type: "text", text: "inspect" }] },
      { id: "a1", role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "c1", name: "read", input: { path: "x" } }] },
      {
        id: "r1",
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        timestamp: 3,
        isError: false,
        content: [{ type: "text", text: "large output\n".repeat(1_000) }],
        details: { nested: { optional: undefined }, values: [1, undefined, Number.NaN] },
      },
      { id: "u2", role: "user", timestamp: 4, content: [{ type: "text", text: "continue" }] },
    ];
    const projected = applyPruning(raw, state, config);
    const selection = {
      startId: state.messageIdsByStableId.get("id:u1")!,
      endId: state.messageIdsByStableId.get("id:r1")!,
      messageCount: 3,
      estimatedTokens: 3_000,
      includedBlockIds: [],
      reason: "json round-trip regression",
    };

    const result = await createAutoCompressionBlock({
      state,
      config,
      messages: projected,
      candidate: selection,
      topic: "json round-trip",
    });

    // Simulate exactly what restart does to the raw session messages: JSONL
    // serialization removes undefined object fields and normalizes unsupported
    // array/number values. Exact membership must still recognize the same
    // provider-visible transcript and materialize the persisted block.
    const reloadedRaw = JSON.parse(JSON.stringify(raw));
    const replay = applyPruning(reloadedRaw, state, config);
    expect(state.compressionBlocks.find((block) => block.id === result.blockId)?.active).toBe(true);
    expect(replay.filter((message: any) => message._dcpBlockId === result.blockId)).toHaveLength(1);
    expect(JSON.stringify(replay)).not.toContain("large output");
  });

  test("v2 block from a pruned projection materializes on raw messages and a later candidate sees the block", async () => {
    const { state, config } = fixture();
    seedToolRecords(state);
    const raw = rawConversation();

    // Pass 1: simulate a previously committed explicit rewrite of the read
    // output. Routine context construction no longer discovers retroactive
    // pruning merely because the result aged.
    state.prunedToolIds.add("c1");
    state.prunedToolReasons.set("c1", "manual-sweep");
    const projected = applyPruning(raw, state, config);
    const prunedResult = projected.find((message: any) => message.toolCallId === "c1");
    expect(JSON.stringify(prunedResult?.content)).toContain("Output removed by /dcp sweep");
    const projectedPrunedHash = canonicalMessageHash(prunedResult);
    const rawHash = canonicalMessageHash(raw[2]);
    expect(projectedPrunedHash).not.toBe(rawHash);

    // Real context pipelines can process the current projection again before
    // auto-compression. Raw provenance must survive that DCP-owned clone.
    const projectedAgain = applyPruning(projected, state, config);
    const candidate = detectCompressionCandidate(projectedAgain, state, config, 0.9);
    expect(candidate).not.toBeNull();
    expect(candidate!.includedBlockIds).toEqual([]);

    const result = await createAutoCompressionBlock({
      state, config, messages: projectedAgain, candidate: candidate!, topic: "projection regression",
    });
    const block = state.compressionBlocks.find((candidateBlock) => candidateBlock.id === result.blockId)!;

    // mutationMembers must bind to the canonical raw content; sourceMembers
    // must keep the projected hash the summarizer actually inspected.
    expect(block.mutationMembers!.find((member) => member.stableId === "id:r1")!.hash).toBe(rawHash);
    expect(block.sourceMembers!.find((member) => member.stableId === "id:r1")!.hash).toBe(projectedPrunedHash);

    // Pass 2 over the original raw messages: the block must materialize and
    // remove the covered raw range (previously exactBlockSpan failed against
    // the raw hashes and the raw messages kept being re-sent).
    const replay = applyPruning(raw, state, config);
    const materialized = replay.filter(
      (message: any) => message._dcpOrigin === "block" && message._dcpBlockId === block.id,
    );
    expect(materialized).toHaveLength(1);
    expect(JSON.stringify(replay)).not.toContain(RAW_TRACE_MARKER);

    // A later candidate over the continued conversation must see the block
    // (start boundary bN / includedBlockIds) instead of re-selecting a
    // partial-overlap raw range inside the compressed section.
    const continued = [
      ...raw,
      { id: "u4", role: "user", timestamp: 30, content: [{ type: "text", text: "turn four" }] },
      { id: "a5", role: "assistant", timestamp: 31, content: [{ type: "text", text: "newer work\n".repeat(300) }] },
      { id: "u5", role: "user", timestamp: 40, content: [{ type: "text", text: "turn five" }] },
      { id: "u6", role: "user", timestamp: 50, content: [{ type: "text", text: "turn six" }] },
    ];
    const replayed = applyPruning(continued, state, config);
    expect(replayed.some((message: any) => message._dcpOrigin === "block" && message._dcpBlockId === block.id)).toBe(true);

    const later = detectCompressionCandidate(replayed, state, config, 0.9);
    expect(later).not.toBeNull();
    expect(later!.startId).toBe(`b${block.id}`);
    expect(later!.includedBlockIds).toContain(block.id);

    // Under active budget pressure, auto-recovery must leave economical
    // existing summaries alone and compress only eligible raw tail growth. The
    // incident repeatedly tried to fold b3/b4 into a larger replacement whose
    // projection was bigger than its source, producing non-positive-gain.
    const recovery = detectCompressionCandidate(replayed, state, config, 0.9, {
      requiredSavingsTokens: 100,
      allowCompressionBlocks: false,
    });
    expect(recovery).not.toBeNull();
    expect(recovery!.includedBlockIds).toEqual([]);
    expect(recovery!.startId).not.toBe(`b${block.id}`);

    // No raw message inside the compressed range may be re-addressed.
    for (const id of ["id:u1", "id:a1", "id:r1", "id:a2", "id:r2", "id:a3"]) {
      expect(state.messageIdsByStableId.get(id)).toBeDefined();
      expect(later!.startId).not.toBe(state.messageIdsByStableId.get(id));
      expect(later!.endId).not.toBe(state.messageIdsByStableId.get(id));
    }
  });

  test("summarizer deadline still leaves time to commit the programmatic fallback", async () => {
    const { state, config } = fixture();
    config.compress.autoCompress.timeoutMs = 25;
    config.compress.autoCompress.summarizerModel = ["zai/glm-hang"];
    const raw = [
      { id: "a", role: "assistant", timestamp: 1, content: [{ type: "text", text: "log line\n".repeat(900) }] },
      { id: "m", role: "assistant", timestamp: 2, content: [{ type: "text", text: "Decision: KEEP_MIDDLE" }] },
      { id: "b", role: "assistant", timestamp: 3, content: [{ type: "text", text: "log line\n".repeat(900) }] },
      { id: "carrier", role: "user", timestamp: 4, content: [{ type: "text", text: "continue" }] },
    ];
    const projected = applyPruning(raw, state, config);
    const selection = {
      startId: state.messageIdsByStableId.get("id:a")!,
      endId: state.messageIdsByStableId.get("id:b")!,
      messageCount: 3, estimatedTokens: 4000, includedBlockIds: [], reason: "deadline regression",
    };

    // Hanging summarizer: its own configured deadline must stop the model
    // attempt, after which the bounded deterministic fallback still commits.
    const registry = {
      find: (provider: string, id: string) => ({ provider, id }),
      getApiKeyAndHeaders: () => new Promise(() => {}),
    };
    const started = Date.now();
    const result = await createBudgetedAutoCompressionBlock(
      { state, config, messages: projected, candidate: selection, topic: "deadline", modelRegistry: registry as any },
      null,
    );

    expect(result.summaryMode).toBe("programmatic_fallback");
    expect(result.summarizerAttempts).toEqual([
      expect.objectContaining({ ref: "zai/glm-hang", outcome: "no-auth" }),
    ]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.nextBlockId).toBe(2);
  });

  test("a true whole-operation overrun is classified as summarizer-unavailable", async () => {
    const { state, config } = fixture();
    config.compress.autoCompress.timeoutMs = 1;
    const raw = [
      { id: "a", role: "assistant", timestamp: 1, content: [{ type: "text", text: "log line\n".repeat(900) }] },
      { id: "b", role: "assistant", timestamp: 2, content: [{ type: "text", text: "log line\n".repeat(900) }] },
      { id: "carrier", role: "user", timestamp: 3, content: [{ type: "text", text: "continue" }] },
    ];
    const projected = applyPruning(raw, state, config);
    const selection = {
      startId: state.messageIdsByStableId.get("id:a")!,
      endId: state.messageIdsByStableId.get("id:b")!,
      messageCount: 2, estimatedTokens: 4000, includedBlockIds: [], reason: "operation deadline regression",
    };

    let caught: unknown;
    try {
      await createBudgetedAutoCompressionBlock({
        state, config, messages: projected, candidate: selection, topic: "deadline",
        // Resolve after the bounded finalization grace so createAutoCompressionBlock
        // regains control, observes the abort, and refuses to publish live state.
        persistState: () => new Promise((resolve) => setTimeout(resolve, 1_150)),
      }, null);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AutoCompressionBlockedError);
    expect((caught as AutoCompressionBlockedError).blockedReason).toBe("summarizer-unavailable");
    expect((caught as Error).message).toContain("whole-operation deadline");
    expect(state.compressionBlocks).toHaveLength(0);
    expect(state.nextBlockId).toBe(1);
  });

  test("parent abort stays a cancellation passthrough and is never reclassified", async () => {
    const { state, config } = fixture();
    config.compress.autoCompress.timeoutMs = 5_000;
    config.compress.autoCompress.summarizerModel = ["zai/glm-hang"];
    const raw = [
      { id: "a", role: "assistant", timestamp: 1, content: [{ type: "text", text: "log line\n".repeat(900) }] },
      { id: "m", role: "assistant", timestamp: 2, content: [{ type: "text", text: "Decision: KEEP_MIDDLE" }] },
      { id: "b", role: "assistant", timestamp: 3, content: [{ type: "text", text: "log line\n".repeat(900) }] },
      { id: "carrier", role: "user", timestamp: 4, content: [{ type: "text", text: "continue" }] },
    ];
    const projected = applyPruning(raw, state, config);
    const selection = {
      startId: state.messageIdsByStableId.get("id:a")!,
      endId: state.messageIdsByStableId.get("id:b")!,
      messageCount: 3, estimatedTokens: 4000, includedBlockIds: [], reason: "parent abort regression",
    };
    const registry = {
      find: (provider: string, id: string) => ({ provider, id }),
      getApiKeyAndHeaders: () => new Promise(() => {}),
    };
    const parent = new AbortController();
    setTimeout(() => parent.abort(new Error("parent-cancelled-reason")), 25);

    let caught: unknown;
    try {
      await createBudgetedAutoCompressionBlock(
        { state, config, messages: projected, candidate: selection, topic: "abort", modelRegistry: registry as any, signal: parent.signal },
        null,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("parent-cancelled-reason");
    expect(caught).not.toBeInstanceOf(AutoCompressionBlockedError);
    expect(state.compressionBlocks).toHaveLength(0);
  });

  test("rejected exact source stays memoized when unrelated provider tail grows", async () => {
    const { state, config } = fixture();
    config.compress.protectUserMessages = true;
    const requirement = `Constraint: ${"keep exact requirement ".repeat(250)}`;
    const raw = [
      { id: "u1", role: "user", timestamp: 1, content: [{ type: "text", text: requirement }] },
      { id: "a1", role: "assistant", timestamp: 2, content: [{ type: "text", text: "ack" }] },
      { id: "u2", role: "user", timestamp: 3, content: [{ type: "text", text: "recent turn" }] },
    ];
    const firstProjection = applyPruning(raw, state, config);
    const selection = {
      startId: state.messageIdsByStableId.get("id:u1")!,
      endId: state.messageIdsByStableId.get("id:a1")!,
      messageCount: 2,
      estimatedTokens: 2_000,
      includedBlockIds: [],
      reason: "memoization regression",
    };

    let firstError: unknown;
    try {
      await createBudgetedAutoCompressionBlock(
        { state, config, messages: firstProjection, candidate: selection, topic: "memo" },
        null,
      );
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(AutoCompressionBlockedError);
    expect((firstError as AutoCompressionBlockedError).blockedReason).toBe("non-positive-gain");

    // Only the provider tail changed. The exact source u1..a1 is byte-identical,
    // so the wrapper must reuse the cached rejection instead of preparing and
    // rejecting the same compression again after every autonomous tool turn.
    const secondProjection = applyPruning([
      ...raw,
      { id: "a2", role: "assistant", timestamp: 4, content: [{ type: "text", text: "unrelated tail growth" }] },
      { id: "u3", role: "user", timestamp: 5, content: [{ type: "text", text: "another recent carrier" }] },
    ], state, config);
    let secondError: unknown;
    try {
      await createBudgetedAutoCompressionBlock(
        { state, config, messages: secondProjection, candidate: selection, topic: "memo" },
        null,
      );
    } catch (error) {
      secondError = error;
    }

    expect(secondError).toBe(firstError);
    expect(state.compressionBlocks).toHaveLength(0);
  });
});
