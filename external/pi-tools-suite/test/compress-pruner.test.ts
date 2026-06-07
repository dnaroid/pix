import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DcpConfig } from "../src/dcp/config.js";
import dcpModule from "../src/dcp/index.js";
import { registerCompressTool } from "../src/dcp/compress-tool.js";
import { registerCommands } from "../src/dcp/commands.js";
import {
  applyPruning,
  appendConcreteNudgeGuidance,
  applyAnchoredNudges,
  clearDcpNudgeAnchors,
  detectCompressionCandidate,
  detectMessageCompressionCandidates,
  estimateTokens,
  getActiveSummaryTokenEstimate,
  getNudgeType,
  resolveContextThresholds,
  upsertNudgeAnchor,
} from "../src/dcp/pruner.js";
import {
  createState,
  createInputFingerprint,
  restoreState,
  serializeState,
  type CompressionBlock,
  type ToolRecord,
} from "../src/dcp/state.js";

function config(overrides: Partial<DcpConfig> = {}): DcpConfig {
  const base: DcpConfig = {
    enabled: true,
    debug: false,
    manualMode: { enabled: false, automaticStrategies: true },
    compress: {
      maxContextPercent: 0.8,
      minContextPercent: 0.4,
      modelMaxContextPercent: {},
      modelMinContextPercent: {},
      summaryBuffer: true,
      nudgeFrequency: 5,
      iterationNudgeThreshold: 15,
      nudgeForce: "soft",
      protectedTools: ["compress", "write", "edit"],
      protectTags: false,
      protectUserMessages: false,
      autoCandidates: {
        enabled: true,
        minContextPercent: 0.4,
        keepRecentTurns: 2,
        minMessages: 6,
        minTokens: 100,
      },
      messageMode: {
        enabled: true,
        minContextPercent: 0.4,
        keepRecentTurns: 2,
        mediumTokens: 500,
        highTokens: 5000,
        maxSuggestions: 5,
      },
    },
    strategies: {
      deduplication: { enabled: true, protectedTools: [] },
      purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
      autoToolPruning: {
        enabled: true,
        maxOutputTokens: 2000,
        keepRecentTurns: 2,
        readLikeTools: ["read", "grep", "repo_search"],
        readLikeTurns: 3,
        protectedTools: [],
      },
    },
    protectedFilePatterns: [],
    pruneNotification: "off",
  };

  return {
    ...base,
    ...overrides,
    manualMode: { ...base.manualMode, ...overrides.manualMode },
    compress: {
      ...base.compress,
      ...overrides.compress,
      autoCandidates: {
        ...base.compress.autoCandidates,
        ...overrides.compress?.autoCandidates,
      },
      messageMode: {
        ...base.compress.messageMode,
        ...overrides.compress?.messageMode,
      },
    },
    strategies: {
      deduplication: {
        ...base.strategies.deduplication,
        ...overrides.strategies?.deduplication,
      },
      purgeErrors: {
        ...base.strategies.purgeErrors,
        ...overrides.strategies?.purgeErrors,
      },
      autoToolPruning: {
        ...base.strategies.autoToolPruning,
        ...overrides.strategies?.autoToolPruning,
      },
    },
  };
}

function textMessage(role: string, text: string, timestamp: number): any {
  return { role, content: [{ type: "text", text }], timestamp };
}

function assistantToolCall(toolCallId: string, timestamp: number): any {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "read", input: {} }],
    timestamp,
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  timestamp: number,
  isError = false,
): any {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    isError,
    content: [{ type: "text", text }],
    timestamp,
  };
}

function toolRecord(
  toolCallId: string,
  toolName: string,
  inputFingerprint: string,
  tokenEstimate: number,
  turnIndex = 0,
  inputArgs: Record<string, unknown> = {},
): ToolRecord {
  return {
    toolCallId,
    toolName,
    inputArgs,
    inputFingerprint,
    isError: false,
    turnIndex,
    timestamp: Date.now(),
    tokenEstimate,
  };
}

function contentText(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content.map((block: any) => typeof block?.text === "string" ? block.text : "").join("");
}

function block(id: number, startTimestamp: number, endTimestamp: number): CompressionBlock {
  return {
    id,
    topic: `Block ${id}`,
    summary: `Summary ${id}`,
    startTimestamp,
    endTimestamp,
    anchorTimestamp: endTimestamp + 1,
    active: true,
    summaryTokenEstimate: 10,
    createdAt: Date.now(),
  };
}

describe("DCP pruning effectiveness", () => {
  test("deduplication and stats are idempotent across repeated pruning passes", () => {
    const state = createState();
    state.toolCalls.set("call-1", toolRecord("call-1", "read", "read::{path:a}", 120));
    state.toolCalls.set("call-2", toolRecord("call-2", "read", "read::{path:a}", 140));

    const cfg = config({
      strategies: {
        deduplication: { enabled: true, protectedTools: [] },
        purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        autoToolPruning: {
          enabled: false,
          maxOutputTokens: 2000,
          keepRecentTurns: 2,
          readLikeTools: [],
          readLikeTurns: 3,
          protectedTools: [],
        },
      },
    });

    const messages = [
      textMessage("user", "start", 1),
      assistantToolCall("call-1", 2),
      toolResult("call-1", "read", "first output", 3),
      assistantToolCall("call-2", 4),
      toolResult("call-2", "read", "second output", 5),
      textMessage("user", "next", 6),
    ];

    const once = applyPruning(messages, state, cfg);
    const totalAfterOnce = state.totalPruneCount;
    const savedAfterOnce = state.tokensSaved;
    const twice = applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("call-1")).toBe(true);
    expect(state.prunedToolIds.has("call-2")).toBe(false);
    expect(totalAfterOnce).toBe(1);
    expect(savedAfterOnce).toBeGreaterThan(0);
    expect(state.totalPruneCount).toBe(totalAfterOnce);
    expect(state.tokensSaved).toBe(savedAfterOnce);
    expect(JSON.stringify(once)).toContain("duplicate tool call");
    expect(JSON.stringify(twice)).toContain("duplicate tool call");
  });

  test("auto-prunes large old tool outputs without LLM compression", () => {
    const state = createState();
    state.toolCalls.set(
      "call-1",
      toolRecord("call-1", "bash", "bash::{cmd:big}", 500, 1, { command: "make noisy" }),
    );

    const cfg = config({
      strategies: {
        deduplication: { enabled: false, protectedTools: [] },
        purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        autoToolPruning: {
          enabled: true,
          maxOutputTokens: 100,
          keepRecentTurns: 2,
          readLikeTools: [],
          readLikeTurns: 3,
          protectedTools: [],
        },
      },
    });

    const messages = [
      textMessage("user", "turn 1", 1),
      assistantToolCall("call-1", 2),
      toolResult("call-1", "bash", "x".repeat(2000), 3),
      textMessage("user", "turn 2", 4),
      textMessage("user", "turn 3", 5),
      textMessage("user", "turn 4", 6),
    ];

    const pruned = applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("call-1")).toBe(true);
    expect(state.prunedToolReasons.get("call-1")).toBe("large-output");
    expect(state.totalPruneCount).toBe(1);
    expect(JSON.stringify(pruned)).toContain("Large tool output removed");
  });

  test("protectedFilePatterns prevent automatic tool-output pruning", () => {
    const state = createState();
    state.toolCalls.set(
      "call-1",
      toolRecord("call-1", "read", "read::{path:secret}", 500, 1, { path: "src/secrets.txt" }),
    );

    const cfg = config({
      protectedFilePatterns: ["src/secrets.txt"],
      strategies: {
        deduplication: { enabled: false, protectedTools: [] },
        purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        autoToolPruning: {
          enabled: true,
          maxOutputTokens: 100,
          keepRecentTurns: 2,
          readLikeTools: ["read"],
          readLikeTurns: 1,
          protectedTools: [],
        },
      },
    });

    applyPruning(
      [
        textMessage("user", "turn 1", 1),
        assistantToolCall("call-1", 2),
        toolResult("call-1", "read", "x".repeat(2000), 3),
        textMessage("user", "turn 2", 4),
        textMessage("user", "turn 3", 5),
      ],
      state,
      cfg,
    );

    expect(state.prunedToolIds.has("call-1")).toBe(false);
    expect(state.totalPruneCount).toBe(0);
  });

  test("nudge cadence honors frequency and can repeat during long user turns", () => {
    const state = createState();
    const cfg = config({ compress: { nudgeFrequency: 2, iterationNudgeThreshold: 4 } as any });
    state.currentTurn = 3;
    state.nudgeCounter = 0;

    expect(getNudgeType(0.5, state, cfg, 0)).toBe(null);

    state.nudgeCounter = 1;
    expect(getNudgeType(0.5, state, cfg, 0)).toBe("turn");

    state.lastNudgeTurn = 3;
    expect(getNudgeType(0.5, state, cfg, 0)).toBe("turn");
    expect(getNudgeType(0.9, state, cfg, 10)).toBe("context-soft");
    expect(getNudgeType(0.5, state, cfg, 10)).toBe("iteration");

    const immediate = createState();
    const immediateCfg = config({ compress: { nudgeFrequency: 1 } as any });
    expect(getNudgeType(0.5, immediate, immediateCfg, 0)).toBe("turn");
  });

  test("nudge thresholds accept percent strings when called without pre-resolved thresholds", () => {
    const state = createState();
    const cfg = config({ compress: { minContextPercent: "25%", maxContextPercent: "80%", nudgeFrequency: 1 } as any });

    expect(getNudgeType(0.24, state, cfg, 0)).toBe(null);
    expect(getNudgeType(0.30, state, cfg, 0)).toBe("turn");
    expect(getNudgeType(0.90, state, cfg, 0)).toBe("context-soft");
  });

  test("anchored nudges persist on existing messages and clear after compression", () => {
    const state = createState();
    const cfg = config({
      strategies: {
        deduplication: { enabled: false, protectedTools: [] },
        purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        autoToolPruning: { enabled: false, maxOutputTokens: 2000, keepRecentTurns: 2, readLikeTools: [], readLikeTurns: 3, protectedTools: [] },
      },
    });
    const pruned = applyPruning([
      textMessage("user", "older request", 1),
      textMessage("assistant", "completed research", 2),
      textMessage("user", "current request", 3),
    ], state, cfg);

    const anchor = upsertNudgeAnchor(pruned, state, "iteration", { contextPercent: 0.52 });
    expect(anchor.created).toBe(true);
    expect(state.nudgeAnchors).toHaveLength(1);
    expect(state.lastNudge?.type).toBe("iteration");

    const duplicate = upsertNudgeAnchor(pruned, state, "turn", { contextPercent: 0.53 });
    expect(duplicate.created).toBe(false);
    expect(state.nudgeAnchors).toHaveLength(1);
    expect(state.nudgeAnchors[0]!.type).toBe("iteration");

    applyAnchoredNudges(pruned, state, () => "<dcp-system-reminder>compress now</dcp-system-reminder>");

    expect(pruned).toHaveLength(3);
    expect(contentText(pruned[2])).toContain("current request");
    expect(contentText(pruned[2])).toContain("compress now");
    expect(contentText(pruned[2])).toContain("[dcp-id]: # (m003)");

    expect(clearDcpNudgeAnchors(state)).toBe(1);
    expect(state.nudgeAnchors).toHaveLength(0);
    expect(state.lastNudge).toBeUndefined();
  });

  test("nudge guidance includes concrete ranges, priority messages, and active blocks", () => {
    const state = createState();
    state.compressionBlocks.push(block(7, 10, 20));

    const text = appendConcreteNudgeGuidance(
      "<dcp-system-reminder>base reminder</dcp-system-reminder>",
      {
        startId: "m001",
        endId: "m009",
        messageCount: 9,
        estimatedTokens: 12_000,
        includedBlockIds: [7],
        reason: "older than recent turns",
      },
      [
        { messageId: "m004", role: "toolResult", estimatedTokens: 8_000, priority: "high", reason: "old" },
        { messageId: "m005", role: "assistant", estimatedTokens: 700, priority: "medium", reason: "old" },
      ],
      state,
    );

    expect(text).toContain("Recommended range candidate: m001..m009");
    expect(text).toContain("m004 (high, toolResult");
    expect(text).not.toContain("m005 (medium");
    expect(text).toContain("b7 \"Block 7\"");
    expect(text).toContain("</dcp-system-reminder>");
    expect(text.indexOf("CONCRETE NEXT ACTION")).toBeLessThan(text.indexOf("</dcp-system-reminder>"));
  });

  test("detects actionable compression candidates outside the active recent turns", () => {
    const state = createState();
    const cfg = config({
      compress: {
        autoCandidates: {
          enabled: true,
          minContextPercent: 0.1,
          keepRecentTurns: 2,
          minMessages: 2,
          minTokens: 10,
        },
      } as any,
      strategies: {
        deduplication: { enabled: false, protectedTools: [] },
        purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        autoToolPruning: {
          enabled: false,
          maxOutputTokens: 2000,
          keepRecentTurns: 2,
          readLikeTools: [],
          readLikeTurns: 3,
          protectedTools: [],
        },
      },
    });

    const pruned = applyPruning(
      [
        textMessage("user", "old user " + "a".repeat(80), 1),
        textMessage("assistant", "old assistant " + "b".repeat(80), 2),
        textMessage("user", "middle user " + "c".repeat(80), 3),
        textMessage("assistant", "middle assistant " + "d".repeat(80), 4),
        textMessage("user", "active user", 5),
        textMessage("assistant", "active assistant", 6),
      ],
      state,
      cfg,
    );

    const candidate = detectCompressionCandidate(pruned, state, cfg, 0.5);

    expect(candidate).not.toBe(null);
    expect(candidate?.startId).toBe("m001");
    expect(candidate?.endId).toBe("m002");
  });

  test("detects legacy malformed dcp-id tags in compression candidates", () => {
    const state = createState();
    const cfg = config({
      compress: {
        autoCandidates: {
          enabled: true,
          minContextPercent: 0.4,
          keepRecentTurns: 1,
          minMessages: 2,
          minTokens: 0,
        },
      } as any,
    });

    const candidate = detectCompressionCandidate(
      [
        textMessage("user", "old user\n<dcp-id=m001</dcp-id>", 1),
        textMessage("assistant", "old assistant\n<dcp-id=m002</dcp-id>", 2),
        textMessage("user", "recent user\n<dcp-id=m003</dcp-id>", 3),
        textMessage("assistant", "recent assistant\n<dcp-id=m004</dcp-id>", 4),
      ],
      state,
      cfg,
      0.5,
    );

    expect(candidate).not.toBe(null);
    expect(candidate?.startId).toBe("m001");
    expect(candidate?.endId).toBe("m002");
  });

  test("strips assistant-echoed DCP metadata before injecting fresh ids", () => {
    const state = createState();

    const pruned = applyPruning(
      [
        textMessage("user", "start", 1),
        {
          role: "assistant",
          content: [{
            type: "text",
            text: "I will inspect that now.\n<dcp-id>m999</dcp-id>\n<dcp-system-reminder>hidden nudge</dcp-system-reminder>",
            textSignature: "signed-original-text",
          }],
          timestamp: 2,
        },
        textMessage("user", "next", 3),
      ],
      state,
      config(),
    );

    const asJson = JSON.stringify(pruned);
    expect(asJson).toContain("I will inspect that now.");
    expect(asJson).not.toContain("m999");
    expect(asJson).not.toContain("hidden nudge");
    expect(asJson).toContain("[dcp-id]: # (m002)");
    expect(state.messageMetaSnapshot.get("m002")?.text).toBe("I will inspect that now.");

    const assistantTextBlock = (pruned[1].content as any[]).find((block) => block.text === "I will inspect that now.");
    expect(assistantTextBlock?.textSignature).toBeUndefined();
  });

  test("keeps user, tool, and assistant code-block DCP examples intact", () => {
    const state = createState();
    const candidateConfig = config({
      compress: {
        autoCandidates: {
          enabled: true,
          minContextPercent: 0.1,
          keepRecentTurns: 1,
          minMessages: 2,
          minTokens: 0,
        },
      } as any,
    });

    const pruned = applyPruning(
      [
        textMessage("user", "literal user example\n<dcp-id>m999</dcp-id>", 1),
        textMessage("assistant", "```xml\n<dcp-id>m777</dcp-id>\n```", 2),
        assistantToolCall("call-1", 3),
        toolResult("call-1", "read", "literal tool output\n<dcp-id>m888</dcp-id>", 4),
        textMessage("user", "recent", 5),
      ],
      state,
      candidateConfig,
    );

    const asJson = JSON.stringify(pruned);
    expect(asJson).toContain("m999");
    expect(asJson).toContain("m777");
    expect(asJson).toContain("m888");

    const candidate = detectCompressionCandidate(pruned, state, candidateConfig, 0.5);

    expect(candidate?.startId).toBe("m001");
  });

  test("compress tool rolls up covered bN blocks and deactivates old blocks", async () => {
    const state = createState();
    state.compressionBlocks = [block(1, 1, 3), block(2, 4, 6)];
    state.nextBlockId = 3;

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    await registeredTool.execute(
      "tool-call",
      {
        topic: "Rollup",
        ranges: [
          {
            startId: "b1",
            endId: "b2",
            summary: "First (b1), then (b2).",
          },
        ],
      },
      undefined,
      undefined,
      { ui: { notify() {} } },
    );

    expect(state.compressionBlocks.find((b) => b.id === 1)?.active).toBe(false);
    expect(state.compressionBlocks.find((b) => b.id === 2)?.active).toBe(false);
    const rollup = state.compressionBlocks.find((b) => b.id === 3);
    expect(rollup?.active).toBe(true);
    expect(rollup?.coveredBlockIds).toEqual([1, 2]);
    expect(rollup?.summary).toContain("Previously compressed: Block 1");
    expect(rollup?.summary).toContain("Previously compressed: Block 2");
  });

  test("compress tool recovers missing, duplicate, and invalid block placeholders", async () => {
    const state = createState();
    state.compressionBlocks = [block(1, 1, 3), block(2, 4, 6)];
    state.nextBlockId = 3;

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    await registeredTool.execute(
      "tool-call",
      {
        topic: "Recovered Rollup",
        ranges: [
          {
            startId: "b1",
            endId: "b2",
            summary: "Rollup accidentally duplicates (b1) and invalid (b999), but omits b2: (b1).",
          },
        ],
      },
      undefined,
      undefined,
      { ui: { notify() {} } },
    );

    const rollup = state.compressionBlocks.find((b) => b.id === 3);
    expect(rollup?.summary).toContain("Previously compressed: Block 1");
    expect(rollup?.summary).toContain("Previously compressed: Block 2");
    expect(rollup?.summary).toContain("preserved automatically");
    expect(rollup?.summary).not.toContain("b999");
  });

  test("compress tool rejects overlapping ranges within one call before mutating state", async () => {
    const state = createState();
    state.messageIdSnapshot.set("m001", 1);
    state.messageIdSnapshot.set("m002", 2);
    state.messageIdSnapshot.set("m003", 3);

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    await expect(registeredTool.execute(
      "tool-call",
      {
        topic: "Overlap",
        ranges: [
          { startId: "m001", endId: "m002", summary: "first" },
          { startId: "m002", endId: "m003", summary: "second" },
        ],
      },
      undefined,
      undefined,
      { ui: { notify() {} } },
    )).rejects.toThrow(/Overlapping ranges/);

    expect(state.compressionBlocks).toHaveLength(0);
  });

  test("compress tool explains stale or unknown range IDs with current ID diagnostics", async () => {
    const state = createState();
    state.messageIdSnapshot.set("m001", 1);
    state.messageMetaSnapshot.set("m001", { timestamp: 1, role: "assistant" });
    state.compressionBlocks = [block(7, 10, 20)];

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    await expect(registeredTool.execute(
      "tool-call",
      { topic: "Stale", ranges: [{ startId: "m015", endId: "m001", summary: "old" }] },
      undefined,
      undefined,
      { ui: { notify() {} } },
    )).rejects.toThrow(/Unknown message ID: m015[\s\S]*Current raw message IDs: m001[\s\S]*Current active block IDs: b7 "Block 7"[\s\S]*use the corresponding bN block ID/i);

    expect(state.compressionBlocks).toHaveLength(1);
  });

  test("compress tool reports per-operation savings and Pi context usage", async () => {
    const state = createState();
    state.tokensSaved = 10_000;
    state.messageIdSnapshot.set("m001", 1);
    state.messageIdSnapshot.set("m002", 2);
    state.messageMetaSnapshot.set("m001", {
      timestamp: 1,
      role: "assistant",
      text: "old assistant output",
      tokenEstimate: 400,
    });
    state.messageMetaSnapshot.set("m002", {
      timestamp: 2,
      role: "assistant",
      text: "older assistant output",
      tokenEstimate: 300,
    });

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    const summary = "short summary";
    const result = await registeredTool.execute(
      "tool-call",
      { topic: "Delta", ranges: [{ startId: "m001", endId: "m002", summary }] },
      undefined,
      undefined,
      { getContextUsage: () => ({ tokens: 1_500, contextWindow: 2_000, percent: 50 }), ui: { notify() {} } },
    );

    const expectedDelta = Math.max(0, 700 - estimateTokens(summary));
    expect(result.details.tokensSaved).toBe(expectedDelta);
    expect(result.details.tokensSaved).not.toBe(state.tokensSaved);
    expect(result.details.contextTokens).toBe(1_000);
    expect(result.details.contextPercent).toBe(50);
    expect(result.details.outputFormat).toBe("json");
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      topic: "Delta",
      tokensSaved: expectedDelta,
      contextTokens: 1_000,
      contextPercent: 50,
      outputFormat: "json",
    });
    expect(result.content[0].text).not.toContain("█");
    expect(result.content[0].text).not.toContain("░");
  });

  test("compress tool rejects partial overlap and preserves protected raw user messages", async () => {
    const state = createState();
    state.compressionBlocks = [block(1, 10, 20)];
    state.messageIdSnapshot.set("m001", 5);
    state.messageIdSnapshot.set("m002", 15);

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    let partialOverlapError: unknown;
    try {
      await registeredTool.execute(
        "tool-call",
        { topic: "Bad", ranges: [{ startId: "m001", endId: "m002", summary: "partial" }] },
        undefined,
        undefined,
        { ui: { notify() {} } },
      );
    } catch (error) {
      partialOverlapError = error;
    }
    expect(partialOverlapError).toBeInstanceOf(Error);
    expect((partialOverlapError as Error).message).toMatch(/partially overlaps/);

    const protectedState = createState();
    protectedState.messageIdSnapshot.set("m001", 1);
    protectedState.messageIdSnapshot.set("m002", 2);
    protectedState.messageMetaSnapshot.set("m001", { timestamp: 1, role: "user", text: "critical user intent" });
    protectedState.messageMetaSnapshot.set("m002", { timestamp: 2, role: "assistant" });

    let protectedTool: any;
    registerCompressTool(
      { registerTool: (tool: any) => { protectedTool = tool } } as any,
      protectedState,
      config({ compress: { protectUserMessages: true } as any }),
    );

    await protectedTool.execute(
      "tool-call",
      { topic: "Protected", ranges: [{ startId: "m001", endId: "m002", summary: "compressed safely" }] },
      undefined,
      undefined,
      { ui: { notify() {} } },
    );
    expect(protectedState.compressionBlocks[0]?.summary).toContain("compressed safely");
    expect(protectedState.compressionBlocks[0]?.summary).toContain("The following user messages");
    expect(protectedState.compressionBlocks[0]?.summary).toContain("critical user intent");
  });

  test("compress tool supports individual message compression and protect tags", async () => {
    const state = createState();
    const cfg = config({ compress: { protectTags: true } as any });

    const visible = applyPruning(
      [
        textMessage("user", "old <protect>exact requirement</protect> " + "x".repeat(200), 1),
        textMessage("assistant", "still useful", 2),
        textMessage("user", "active", 3),
      ],
      state,
      cfg,
    );

    expect(JSON.stringify(visible)).toContain("m001");

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, cfg);

    await registeredTool.execute(
      "tool-call",
      {
        topic: "Single Message",
        messages: [
          {
            messageId: "m001",
            topic: "Old Prompt",
            summary: "User provided an old large prompt that is no longer needed verbatim.",
          },
        ],
      },
      undefined,
      undefined,
      { ui: { notify() {} } },
    );

    const block = state.compressionBlocks[0];
    expect(block?.mode).toBe("message");
    expect(block?.topic).toBe("Old Prompt");
    expect(block?.summary).toContain("exact requirement");

    const pruned = applyPruning(
      [
        textMessage("user", "old <protect>exact requirement</protect> " + "x".repeat(200), 1),
        textMessage("assistant", "still useful", 2),
        textMessage("user", "active", 3),
      ],
      state,
      cfg,
    );
    const asJson = JSON.stringify(pruned);
    expect(asJson).toContain("Compressed section: Old Prompt");
    expect(asJson).not.toContain("x".repeat(80));
    expect(asJson).toContain("still useful");
  });

  test("message compression soft-skips invalid entries and reports grouped diagnostics", async () => {
    const state = createState();
    state.messageIdSnapshot.set("m001", 1);
    state.messageIdSnapshot.set("m002", 2);
    state.messageMetaSnapshot.set("m001", { timestamp: 1, role: "assistant", tokenEstimate: 120 });
    state.messageMetaSnapshot.set("m002", { timestamp: 2, role: "user", tokenEstimate: 80 });

    let registeredTool: any;
    registerCompressTool(
      { registerTool: (tool: any) => { registeredTool = tool } } as any,
      state,
      config({ compress: { protectUserMessages: true } as any }),
    );

    const result = await registeredTool.execute(
      "tool-call",
      {
        topic: "Mixed Messages",
        messages: [
          { messageId: "m001", summary: "valid assistant summary" },
          { messageId: "m001", summary: "duplicate should skip" },
          { messageId: "b9", summary: "block should skip" },
          { messageId: "m999", summary: "missing should skip" },
          { messageId: "m002", summary: "protected should skip" },
        ],
      },
      undefined,
      undefined,
      { ui: { notify() {} } },
    );

    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks[0]?.summary).toContain("valid assistant summary");
    expect(result.details.skippedMessages).toBe(4);
    expect(result.details.skippedMessageIssues.join("\n")).toContain("selected more than once");
    expect(result.details.skippedMessageIssues.join("\n")).toContain("protected by compress.protectUserMessages");
    expect(result.details.skippedMessageIssues.join("\n")).toContain("Current raw message IDs: m001, m002.");

    const allSkippedState = createState();
    allSkippedState.messageMetaSnapshot.set("m001", { timestamp: 1, role: "user" });
    let allSkippedTool: any;
    registerCompressTool(
      { registerTool: (tool: any) => { allSkippedTool = tool } } as any,
      allSkippedState,
      config({ compress: { protectUserMessages: true } as any }),
    );
    await expect(allSkippedTool.execute(
      "tool-call",
      { topic: "No Valid", messages: [{ messageId: "m001", summary: "skip" }] },
      undefined,
      undefined,
      { ui: { notify() {} } },
    )).rejects.toThrow(/Unable to compress any requested messages/);
  });

  test("message compression candidates prioritize large stale messages", () => {
    const state = createState();
    const cfg = config({
      compress: {
        messageMode: {
          enabled: true,
          minContextPercent: 0.1,
          keepRecentTurns: 1,
          mediumTokens: 20,
          highTokens: 100,
          maxSuggestions: 3,
        },
      } as any,
    });

    const pruned = applyPruning(
      [
        textMessage("user", "old small", 1),
        textMessage("assistant", "old huge " + "h".repeat(600), 2),
        textMessage("assistant", "old medium " + "m".repeat(120), 3),
        textMessage("user", "active huge " + "a".repeat(1000), 4),
      ],
      state,
      cfg,
    );

    const candidates = detectMessageCompressionCandidates(pruned, cfg, 0.5);

    expect(candidates.map((candidate) => candidate.messageId)).toEqual(["m002", "m003"]);
    expect(candidates[0]?.priority).toBe("high");
    expect(candidates[1]?.priority).toBe("medium");
    expect(JSON.stringify(pruned)).toContain("[dcp-id]: # (m002)");
    expect(JSON.stringify(pruned)).not.toContain("priority=high");
    expect(state.messageMetaSnapshot.get("m002")?.priority).toBe("high");
  });

  test("compression blocks prefer stable raw message IDs over changed timestamps", async () => {
    const state = createState();
    const cfg = config();
    applyPruning(
      [
        { ...textMessage("assistant", "old stable", 100), _dcpEntryId: "entry-a" },
        { ...textMessage("user", "recent", 200), _dcpEntryId: "entry-b" },
      ],
      state,
      cfg,
    );

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, cfg);
    await registeredTool.execute(
      "tool-call",
      { topic: "Stable", messages: [{ messageId: "m001", summary: "stable summary" }] },
      undefined,
      undefined,
      { ui: { notify() {} } },
    );

    expect(state.compressionBlocks[0]?.startMessageId).toBe("id:entry-a");

    const pruned = applyPruning(
      [
        { ...textMessage("assistant", "old stable", 999), _dcpEntryId: "entry-a" },
        { ...textMessage("user", "recent", 1000), _dcpEntryId: "entry-b" },
      ],
      state,
      cfg,
    );

    const asJson = JSON.stringify(pruned);
    expect(asJson).toContain("Compressed section: Stable");
    expect(asJson).toContain("stable summary");
    expect(asJson).not.toContain("old stable");
  });

  test("compression block sync deactivates blocks whose origin compress call disappeared", () => {
    const state = createState();
    const cfg = config();
    state.toolCalls.set("compress-call", toolRecord("compress-call", "compress", "compress::{}", 10));
    state.compressionBlocks = [
      {
        ...block(1, 1, 1),
        createdByToolCallId: "compress-call",
        startMessageId: "id:entry-a",
        endMessageId: "id:entry-a",
      },
    ];

    const pruned = applyPruning(
      [{ ...textMessage("assistant", "old stable", 1), _dcpEntryId: "entry-a" }],
      state,
      cfg,
    );

    expect(state.compressionBlocks[0]?.active).toBe(false);
    expect(state.compressionBlocks[0]?.deactivatedReason).toBe("missing-origin-compress-call");
    expect(JSON.stringify(pruned)).toContain("old stable");
  });

  test("protected tool outputs and subagent result artifacts are appended to summaries", async () => {
    const state = createState();
    const cwd = mkdtempSync(join(tmpdir(), "dcp-subagent-result-"));
    const agentDir = join(cwd, ".pi", "subagents", "run", "agent-1");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "result.md"), "full subagent result body");

    state.messageIdSnapshot.set("m001", 1);
    state.messageMetaSnapshot.set("m001", {
      timestamp: 1,
      role: "toolResult",
      toolCallId: "call-sub",
      toolName: "subagents",
      text: "compact subagent summary",
      tokenEstimate: 50,
    });
    state.toolCalls.set("call-sub", {
      ...toolRecord("call-sub", "subagents", "subagents::{}", 50),
      outputText: "compact subagent summary\nFull result: .pi/subagents/run/agent-1/result.md",
      outputDetails: {
        artifacts: { resultMd: ".pi/subagents/run/agent-1/result.md" },
      },
    });

    let registeredTool: any;
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      registerCompressTool(
        { registerTool: (tool: any) => { registeredTool = tool } } as any,
        state,
        config({ compress: { protectedTools: ["subagents"] } as any }),
      );
      await registeredTool.execute(
        "tool-call",
        { topic: "Protected Tool", ranges: [{ startId: "m001", endId: "m001", summary: "tool summary" }] },
        undefined,
        undefined,
        { ui: { notify() {} } },
      );
    } finally {
      process.chdir(previousCwd);
    }

    const summary = state.compressionBlocks[0]?.summary ?? "";
    expect(summary).toContain("compact subagent summary");
    expect(summary).toContain("full subagent result body");
  });

  test("per-model thresholds and summaryBuffer adjust nudge decisions", () => {
    const state = createState();
    state.currentTurn = 1;
    state.nudgeCounter = 1;
    state.compressionBlocks = [
      {
        ...block(1, 1, 2),
        summaryTokenEstimate: 150,
      },
    ];

    const cfg = config({
      compress: {
        maxContextPercent: 0.8,
        minContextPercent: 0.4,
        modelMaxContextPercent: { "test/model": 0.6 },
        modelMinContextPercent: { "test/model": 0.2 },
        nudgeFrequency: 1,
      } as any,
    });

    const thresholds = resolveContextThresholds(cfg, ["test/model"]);
    expect(thresholds).toEqual({ minContextPercent: 0.2, maxContextPercent: 0.6 });
    expect(getActiveSummaryTokenEstimate(state)).toBe(150);
    thresholds.maxContextPercent += getActiveSummaryTokenEstimate(state) / 1000;

    expect(getNudgeType(0.7, state, cfg, 0, thresholds)).toBe("turn");
    expect(getNudgeType(0.8, state, cfg, 0, thresholds)).toBe("context-soft");

    const absolute = resolveContextThresholds(
      config({
        compress: {
          minContextLimit: 250,
          maxContextLimit: "75%",
          modelMaxContextLimits: { "test/model": 500 },
        } as any,
      }),
      ["test/model"],
      1000,
    );
    expect(absolute).toEqual({ minContextPercent: 0.25, maxContextPercent: 0.5 });
  });

  test("/dcp recompress re-applies a user-decompressed block", async () => {
    const state = createState();
    state.compressionBlocks = [block(1, 1, 2)];

    let command: any;
    const pi = {
      registerCommand(_name: string, registered: any) {
        command = registered;
      },
      sendMessage() {},
    } as any;
    const notifications: string[] = [];
    const ctx = {
      ui: { notify(message: string) { notifications.push(message) } },
      waitForIdle: async () => {},
      sessionManager: { getBranch: () => [] },
    } as any;

    registerCommands(pi, state, config());

    await command.handler("decompress 1", ctx);
    expect(state.compressionBlocks[0]?.active).toBe(false);
    expect(state.compressionBlocks[0]?.deactivatedByUser).toBe(true);

    await command.handler("recompress 1", ctx);
    expect(state.compressionBlocks[0]?.active).toBe(true);
    expect(state.compressionBlocks[0]?.deactivatedByUser).toBe(false);
    expect(notifications.join("\n")).toContain("Recompressed block b1");
  });

  test("/dcp stats reports nudge telemetry from session entries and active anchors", async () => {
    const state = createState();
    state.tokensSaved = 1234;
    state.totalPruneCount = 2;
    state.nudgeAnchors = [
      {
        id: 1,
        type: "iteration",
        anchorTimestamp: 10,
        anchorStableId: "id:user-10",
        anchorRole: "user",
        turnIndex: 3,
        contextPercent: 0.66,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ];

    let command: any;
    const sentMessages: any[] = [];
    const pi = {
      registerCommand(_name: string, registered: any) {
        command = registered;
      },
      sendMessage(message: any) { sentMessages.push(message) },
    } as any;
    const notifications: string[] = [];
    const ctx = {
      ui: { notify(message: string) { notifications.push(message) } },
      waitForIdle: async () => {},
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: "dcp-nudge",
            data: {
              event: "emitted",
              type: "turn",
              contextPercent: 31.5,
              createdAt: 1000,
            },
          },
          {
            type: "custom",
            customType: "dcp-nudge",
            data: {
              event: "upgraded",
              type: "iteration",
              contextPercent: 66.1,
              createdAt: 2000,
            },
          },
          {
            type: "custom",
            customType: "dcp-nudge",
            data: {
              event: "cleared",
              clearedAnchors: 2,
              createdAt: 3000,
            },
          },
        ],
      },
    } as any;

    registerCommands(pi, state, config());

    await command.handler("stats", ctx);
    expect(notifications).toHaveLength(0);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.customType).toBe("pix-system");
    expect(sentMessages[0]?.display).toBe(true);
    expect(sentMessages[0]?.details?.kind).toBe("dcp-stats");
    expect(sentMessages[0]?.details?.userVisibleOnly).toBe(true);
    const output = sentMessages[0]?.content ?? "";
    expect(output).toContain("Nudge telemetry:");
    expect(output).toContain("Sent: 1 emitted, 1 upgraded");
    expect(output).toContain("turn=1");
    expect(output).toContain("iteration=1");
    expect(output).toContain("Active anchors: 1");
    expect(output).toContain("Cleared after compress: 1 time (2 anchors)");
    expect(output).toContain("Compliance proxy: 1 compress-after-nudge / 2 nudge events (50.0%)");
    expect(output).toContain("Last nudge: iteration upgraded");
  });

  test("DCP context transform hides /dcp stats custom messages from the model", async () => {
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
      sendMessage() {},
    } as any;

    await dcpModule(pi);
    const contextHandler = handlers.get("context")?.[0];
    expect(contextHandler).toBeDefined();

    const result = await contextHandler?.(
      {
        type: "context",
        messages: [
          textMessage("user", "keep me", 1),
          {
            role: "custom",
            customType: "pix-system",
            content: "DCP Session Statistics: user-visible stats",
            display: true,
            details: { userVisibleOnly: true },
            timestamp: 2,
          },
        ],
      },
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        getContextUsage: () => ({ tokens: 10, contextWindow: 10_000, percent: 0.1 }),
      },
    ) as { messages: any[] } | undefined;

    const rendered = result?.messages
      .map((message) => Array.isArray(message.content)
        ? message.content.map((part: any) => part?.text ?? "").join("")
        : String(message.content ?? ""))
      .join("\n") ?? "";
    expect(rendered).toContain("keep me");
    expect(rendered).not.toContain("DCP Session Statistics");
  });

  test("DCP module stays headless and does not register TUI/display hooks", async () => {
    const events: string[] = [];
    const pi = {
      on(event: string) {
        events.push(event);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
      sendMessage() {},
    } as any;

    await dcpModule(pi);

    expect(events).not.toContain("message_start");
    expect(events).not.toContain("message_update");
    expect(events).not.toContain("message_end");
    expect(events).not.toContain("turn_end");
  });

  test("serialized state preserves tool fingerprints and accounting across reload", () => {
    const state = createState();
    const inputFingerprint = createInputFingerprint("read", { path: "a" });
    state.toolCalls.set("call-1", toolRecord("call-1", "read", inputFingerprint, 100));
    state.prunedToolIds.add("call-1");
    state.prunedToolReasons.set("call-1", "duplicate");
    state.accountedPrunedToolIds.add("call-1");
    state.tokensSaved = 100;
    state.totalPruneCount = 1;
    state.nudgeAnchors.push({
      id: 3,
      type: "iteration",
      anchorTimestamp: 42,
      anchorStableId: "id:entry-42",
      anchorRole: "user",
      turnIndex: 7,
      contextPercent: 0.61,
      createdAt: 123,
      updatedAt: 456,
    });
    state.nextNudgeAnchorId = 4;
    state.lastNudge = {
      type: "iteration",
      anchorId: 3,
      anchorTimestamp: 42,
      anchorStableId: "id:entry-42",
      contextPercent: 0.61,
      createdAt: 456,
    };

    const restored = createState();
    restoreState(restored, serializeState(state));

    expect(restored.toolCalls.get("call-1")?.inputFingerprint).toBe(inputFingerprint);
    expect(restored.prunedToolIds.has("call-1")).toBe(true);
    expect(restored.prunedToolReasons.get("call-1")).toBe("duplicate");
    expect(restored.accountedPrunedToolIds.has("call-1")).toBe(true);
    expect(restored.tokensSaved).toBe(100);
    expect(restored.totalPruneCount).toBe(1);
    expect(restored.nudgeAnchors).toHaveLength(1);
    expect(restored.nudgeAnchors[0]?.anchorStableId).toBe("id:entry-42");
    expect(restored.nextNudgeAnchorId).toBe(4);
    expect(restored.lastNudge?.type).toBe("iteration");
  });
});
