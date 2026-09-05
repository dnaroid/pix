import { describe, expect, test } from "bun:test";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type DcpConfig } from "../src/dcp/config.js";
import dcpModule from "../src/dcp/index.js";
import { registerCompressTool } from "../src/dcp/compress-tool.js";
import { registerCommands } from "../src/dcp/commands.js";
import {
  applyPruning,
  appendConcreteNudgeGuidance,
  analyzeEmergencyCurrentTurn,
  applyAnchoredNudges,
  clearDcpNudgeAnchors,
  detectCompressionCandidate,
  detectEmergencyCompressionCandidate,
  detectMessageCompressionCandidates,
  emergencyCurrentTurnMessageCandidates,
  emergencyPressureState,
  estimateTokens,
  getActiveSummaryTokenEstimate,
  getNudgeType,
  injectNudge,
  pruneEmergencyCurrentTurn,
  resolveContextThresholds,
  upsertNudgeAnchor,
} from "../src/dcp/pruner.js";
import {
  collectProviderToolResultEvidence,
  providerPayloadIncludesToolResult,
  providerPayloadRevision,
  ProviderEvidenceTracker,
} from "../src/dcp/provider-tool-results.js";
import { decideDcpProgress, inferDcpBlockedReason, planDcpBudget } from "../src/dcp/progress-controller.js";
import { dcpDebugLogDrain } from "../src/dcp/debug-log.js";
import {
  createState,
  createInputFingerprint,
  resetState,
  restoreState,
  serializeState,
  type CompressionBlock,
  type ToolRecord,
} from "../src/dcp/state.js";
import { stableMessageKeys } from "../src/dcp/pruner-message-ids.js";
import { applyCompressionBlocks } from "../src/dcp/pruner-compression-blocks.js";
import { createRangeCompressionBlock } from "../src/dcp/compression-blocks.js";
import {
  stripStaleDcpMetadataFromAssistantMessage,
} from "../src/dcp/pruner-metadata.js";
import {
  AutoCompressionBlockedError,
  decideAutoCompress,
  createAutoCompressionBlock,
} from "../src/dcp/auto-compress.js";
import type { CompressionCandidate } from "../src/dcp/pruner-types.js";

function config(overrides: any = {}): DcpConfig {
  const base: DcpConfig = {
    enabled: true,
    debug: false,
    manualMode: { enabled: false, automaticStrategies: true },
    compress: {
      maxContextPercent: 0.65,
      minContextPercent: 0.40,
      modelMaxContextPercent: {},
      modelMinContextPercent: {},
      summaryBuffer: true,
      nudgeFrequency: 2,
      iterationNudgeThreshold: 8,
      nudgeForce: "soft",
      protectedTools: ["compress", "write", "edit"],
      protectTags: false,
      protectUserMessages: false,
      autoCandidates: {
        enabled: true,
        minContextPercent: 0.40,
        keepRecentTurns: 2,
        minMessages: 6,
        minTokens: 100,
      },
      messageMode: {
        enabled: true,
        minContextPercent: 0.40,
        keepRecentTurns: 2,
        mediumTokens: 500,
        highTokens: 5000,
        maxSuggestions: 5,
      },
      autoCompress: {
        enabled: false,
        patience: 2,
        summarizerModel: [],
        timeoutMs: 20000,
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
      emergencyCurrentTurnPruning: {
        enabled: true,
        hardContextPercent: 0.82,
        targetContextPercent: 0.70,
        patience: 2,
        keepRecentToolPairs: 8,
        minOutputTokens: 500,
        maxSuggestions: 8,
        protectedTools: [],
      },
    },
    protectedFilePatterns: [],
    pruneNotification: "off",
    modelOverrides: {},
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
      autoCompress: {
        ...base.compress.autoCompress,
        ...overrides.compress?.autoCompress,
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
      emergencyCurrentTurnPruning: {
        ...base.strategies.emergencyCurrentTurnPruning,
        ...overrides.strategies?.emergencyCurrentTurnPruning,
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

function readPersistedDcpPayloadSync(path: string): any {
  const document = JSON.parse(readFileSync(path, "utf8"));
  return document?.kind === "dcp-state" ? document.payload : document;
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
  test("resolveContextThresholds supports wildcard model keys with provider-specific precedence", () => {
    const baseCompress = config().compress;
    const thresholds = resolveContextThresholds(
      config({
        compress: {
          ...baseCompress,
          modelMinContextPercent: {
            "gpt-*": "20%",
            "openai/*": "30%",
          },
          modelMaxContextPercent: {
            "gpt-*": "40%",
            "openai/*": "45%",
            "openai/gpt-5": "50%",
          },
        },
      }),
      ["openai/gpt-5", "gpt-5"],
      200_000,
    );

    expect(thresholds.minContextPercent).toBe(0.3);
    expect(thresholds.maxContextPercent).toBe(0.5);
  });

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
      toolResult("call-1", "read", "same output", 3),
      assistantToolCall("call-2", 4),
      toolResult("call-2", "read", "same output", 5),
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

  test("same input with changed output is not treated as an exact duplicate", () => {
    const state = createState();
    state.toolCalls.set("read-before", toolRecord("read-before", "read", "read::{path:a}", 120));
    state.toolCalls.set("read-after", toolRecord("read-after", "read", "read::{path:a}", 120));
    const cfg = config({
      strategies: {
        deduplication: { enabled: true, protectedTools: [] },
        purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        autoToolPruning: { enabled: false, maxOutputTokens: 2000, keepRecentTurns: 2, readLikeTools: [], readLikeTurns: 3, protectedTools: [] },
      },
    });
    const messages = [
      textMessage("user", "inspect", 1),
      assistantToolCall("read-before", 2),
      toolResult("read-before", "read", "version one", 3),
      assistantToolCall("read-after", 4),
      toolResult("read-after", "read", "version two after file changed", 5),
      textMessage("user", "continue", 6),
    ];

    const projected = applyPruning(messages, state, cfg);
    expect(state.prunedToolIds).toEqual(new Set());
    expect(JSON.stringify(projected)).toContain("version one");
    expect(JSON.stringify(projected)).toContain("version two after file changed");
  });

  test("automatic duplicate pruning waits for a user-turn checkpoint", () => {
    const state = createState();
    state.toolCalls.set("call-1", toolRecord("call-1", "read", "same", 120, 1));
    state.toolCalls.set("call-2", toolRecord("call-2", "read", "same", 140, 1));
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
    const firstPair = [
      textMessage("user", "active", 1),
      assistantToolCall("call-1", 2),
      toolResult("call-1", "read", "same", 3),
    ];

    applyPruning(firstPair, state, cfg);
    const sameTurn = applyPruning([
      ...firstPair,
      assistantToolCall("call-2", 4),
      toolResult("call-2", "read", "same", 5),
    ], state, cfg);
    expect(state.prunedToolIds).toEqual(new Set());
    expect(JSON.stringify(sameTurn)).toContain("same");

    const nextTurn = applyPruning([
      ...firstPair,
      assistantToolCall("call-2", 4),
      toolResult("call-2", "read", "same", 5),
      textMessage("user", "continue", 6),
    ], state, cfg);
    expect(state.prunedToolIds).toEqual(new Set(["call-1"]));
    expect(JSON.stringify(nextTurn)).toContain("duplicate tool call");
  });

  test("auto-prunes large old tool outputs without LLM compression", () => {
    const state = createState();
    state.toolCalls.set(
      "call-1",
      toolRecord("call-1", "read", "read::{path:big}", 500, 1, { path: "large.log" }),
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
      toolResult("call-1", "read", "x".repeat(2000), 3),
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

  test("mutating tool aliases are protected case-insensitively and unknown tools fail safe", () => {
    const cfg = config({
      strategies: {
        deduplication: { enabled: false, protectedTools: [] },
        purgeErrors: { enabled: false, turns: 1, protectedTools: [] },
        autoToolPruning: {
          enabled: true,
          maxOutputTokens: 1,
          keepRecentTurns: 0,
          readLikeTools: ["read"],
          readLikeTurns: 0,
          protectedTools: [],
        },
      },
    });

    for (const [index, toolName] of ["Write", "Edit", "apply_patch", "shell", "bash", "powershell", "mystery_mutator"].entries()) {
      const state = createState();
      const id = `mutating-${index}`;
      state.currentTurn = 3;
      state.toolCalls.set(id, toolRecord(id, toolName, `${toolName}::same`, 500, 0));
      const messages = [
        textMessage("user", "old", 1),
        assistantToolCall(id, 2),
        toolResult(id, toolName, "important mutation evidence ".repeat(50), 3),
        textMessage("user", "later", 4),
      ];
      const projected = applyPruning(messages, state, cfg);
      expect(state.prunedToolIds.has(id)).toBe(false);
      expect(JSON.stringify(projected)).toContain("important mutation evidence");
    }
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

  test("context-limit nudges bypass routine cadence", () => {
    const state = createState();
    const cfg = config({ compress: { nudgeFrequency: 99, minContextPercent: 0.40, maxContextPercent: 0.65 } as any });

    expect(getNudgeType(0.41, state, cfg, 0)).toBe(null);
    expect(getNudgeType(0.66, state, cfg, 0)).toBe("context-soft");
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

    const upgrade = upsertNudgeAnchor(pruned, state, "context-strong", { contextPercent: 0.90 });
    expect(upgrade.created).toBe(false);
    expect(upgrade.updated).toBe(true);
    expect(state.nudgeAnchors).toHaveLength(1);
    expect(state.nudgeAnchors[0]!.type).toBe("context-strong");

    applyAnchoredNudges(pruned, state, () => "<dcp-system-reminder>compress now</dcp-system-reminder>");

    expect(pruned).toHaveLength(3);
    expect(contentText(pruned[2])).toContain("current request");
    expect(contentText(pruned[2])).toContain("compress now");
    expect(contentText(pruned[2])).not.toContain("[dcp-id]");
    expect(state.messageMetaSnapshot.get("m003")?.text).toContain("current request");

    expect(clearDcpNudgeAnchors(state)).toBe(1);
    expect(state.nudgeAnchors).toHaveLength(0);
    expect(state.lastNudge).toBeUndefined();
  });

  test("anchored nudge rendering stays frozen until a priority upgrade", () => {
    const state = createState();
    const raw = [textMessage("user", "request", 1), textMessage("assistant", "answer", 2)];

    upsertNudgeAnchor(raw, state, "turn", {
      contextPercent: 0.5,
      renderedReminder: "<dcp-system-reminder>first candidate m001</dcp-system-reminder>",
    });
    const firstPass = raw.map((message) => ({ ...message, content: [...message.content] }));
    applyAnchoredNudges(firstPass, state, () => "must not render");

    const repeated = upsertNudgeAnchor(raw, state, "turn", {
      contextPercent: 0.55,
      renderedReminder: "<dcp-system-reminder>changed candidate m999</dcp-system-reminder>",
    });
    const secondPass = raw.map((message) => ({ ...message, content: [...message.content] }));
    applyAnchoredNudges(secondPass, state, () => "must not render");

    expect(repeated.updated).toBe(false);
    expect(contentText(secondPass[0])).toBe(contentText(firstPass[0]));
    expect(contentText(secondPass[0])).not.toContain("m999");

    const upgraded = upsertNudgeAnchor(raw, state, "context-strong", {
      contextPercent: 0.9,
      renderedReminder: "<dcp-system-reminder>upgraded once</dcp-system-reminder>",
    });
    const upgradedPass = raw.map((message) => ({ ...message, content: [...message.content] }));
    applyAnchoredNudges(upgradedPass, state, () => "must not render");

    expect(upgraded.updated).toBe(true);
    expect(contentText(upgradedPass[0])).toContain("upgraded once");
  });

  test("nudge anchors stay on their original carrier until cleared", () => {
    const state = createState();
    const firstMessages = [
      textMessage("user", "first request", 1),
      textMessage("assistant", "first response", 2),
    ];

    const first = upsertNudgeAnchor(firstMessages, state, "turn");
    expect(first.created).toBe(true);
    expect(state.nudgeAnchors).toHaveLength(1);
    expect(state.nudgeAnchors[0]?.anchorTimestamp).toBe(1);

    const nextMessages = [
      ...firstMessages,
      textMessage("user", "next request", 3),
      textMessage("assistant", "next response", 4),
    ];
    const moved = upsertNudgeAnchor(nextMessages, state, "iteration");

    expect(moved.created).toBe(false);
    expect(moved.updated).toBe(true);
    expect(state.nudgeAnchors).toHaveLength(1);
    expect(state.nudgeAnchors[0]?.anchorTimestamp).toBe(1);
    expect(state.nudgeAnchors[0]?.type).toBe("iteration");
  });

  test("assistant fallback uses one stable synthetic user carrier", () => {
    const state = createState();
    upsertNudgeAnchor([textMessage("assistant", "first response", 1)], state, "iteration");

    const messages = [
      textMessage("assistant", "first response", 1),
      textMessage("assistant", "second response", 2),
    ];
    upsertNudgeAnchor(messages, state, "iteration");
    applyAnchoredNudges(messages, state, () =>
      "<dcp-system-reminder>singleton reminder</dcp-system-reminder>",
    );

    expect(state.nudgeAnchors).toHaveLength(1);
    expect(state.nudgeAnchors[0]?.anchorTimestamp).toBe(1);
    expect(JSON.stringify(messages).match(/<dcp-system-reminder>/g)).toHaveLength(1);
    expect(contentText(messages[0])).not.toContain("singleton reminder");
    expect(messages[1]?.role).toBe("user");
    expect(contentText(messages[1])).toContain("singleton reminder");
    expect(contentText(messages[2])).toBe("second response");
  });

  test("literal reminder tags in user text do not force assistant fallback", () => {
    const state = createState();
    const messages = [
      textMessage("user", "why is <dcp-system-reminder>old</dcp-system-reminder> repeated?", 1),
      textMessage("assistant", "I will investigate", 2),
    ];

    upsertNudgeAnchor(messages, state, "turn");
    applyAnchoredNudges(messages, state, () =>
      "<dcp-system-reminder>generated reminder</dcp-system-reminder>",
    );

    expect(state.nudgeAnchors).toHaveLength(1);
    expect(state.nudgeAnchors[0]?.anchorRole).toBe("user");
    expect(state.nudgeAnchors[0]?.anchorTimestamp).toBe(1);
    expect(contentText(messages[0])).toContain("<dcp-system-reminder>old</dcp-system-reminder>");
    expect(contentText(messages[0]).match(/generated reminder/g)).toHaveLength(1);
  });

  test("fake block tags in user text remain real anchor candidates", () => {
    const state = createState();
    const messages = [textMessage("user", "[dcp-block-id]: # (b1)", 1)];

    const result = upsertNudgeAnchor(messages, state, "iteration");
    expect(result.anchor).not.toBeNull();
    expect(result.anchor?.anchorRole).toBe("user");
    expect(result.anchor?.anchorTimestamp).toBe(1);
  });

  test("synthetic fallback clears persisted anchors before rendering", () => {
    const state = createState();
    state.compressionBlocks = [block(1, 1, 1)];
    state.nextBlockId = 2;
    const messages = applyCompressionBlocks([textMessage("user", "real source", 1)], state);
    state.nudgeAnchors = [{
      id: 1,
      type: "iteration",
      anchorTimestamp: 1,
      anchorRole: "user",
      turnIndex: 1,
      createdAt: 100,
      updatedAt: 100,
    }];

    const result = upsertNudgeAnchor(messages, state, "iteration");
    expect(result.anchor).toBeNull();
    expect(state.nudgeAnchors).toHaveLength(0);
    expect(state.lastNudge).toBeUndefined();

    injectNudge(messages, "<dcp-system-reminder>fallback</dcp-system-reminder>");
    expect((messages.at(-1) as any)?._dcpOrigin).toBe("dcp-control");
    applyAnchoredNudges(messages, state, () =>
      "<dcp-system-reminder>stale anchor</dcp-system-reminder>",
    );

    expect(JSON.stringify(messages).match(/<dcp-system-reminder>/g)).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain("fallback");
    expect(JSON.stringify(messages)).not.toContain("stale anchor");
  });

  test("legacy multi-anchor state renders only the newest valid reminder", () => {
    const state = createState();
    const messages = [
      textMessage("user", "request", 1),
      textMessage("assistant", "response", 2),
    ];
    state.nudgeAnchors = [
      {
        id: 1,
        type: "turn",
        anchorTimestamp: 1,
        anchorRole: "user",
        turnIndex: 1,
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: 2,
        type: "iteration",
        anchorTimestamp: 2,
        anchorRole: "assistant",
        turnIndex: 1,
        createdAt: 200,
        updatedAt: 200,
      },
      {
        id: 3,
        type: "context-strong",
        anchorTimestamp: 99,
        anchorRole: "assistant",
        turnIndex: 1,
        createdAt: 300,
        updatedAt: 300,
      },
    ];

    applyAnchoredNudges(messages, state, (anchor) =>
      `<dcp-system-reminder>anchor ${anchor.id}</dcp-system-reminder>`,
    );

    expect(state.nudgeAnchors).toHaveLength(1);
    expect(state.nudgeAnchors[0]?.id).toBe(2);
    expect(JSON.stringify(messages).match(/<dcp-system-reminder>/g)).toHaveLength(1);
    expect(contentText(messages[0])).not.toContain("anchor 1");
    expect(contentText(messages[1])).not.toContain("anchor 2");
    expect(messages[2]?.role).toBe("user");
    expect(contentText(messages[2])).toContain("anchor 2");
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

  test("budget-aware compression candidate picks the minimal protocol-safe oldest prefix", () => {
    const state = createState();
    const cfg = config({
      compress: {
        autoCandidates: {
          enabled: true,
          minContextPercent: 0.1,
          keepRecentTurns: 1,
          minMessages: 2,
          minTokens: 0,
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
    const pruned = applyPruning([
      textMessage("user", "old request", 1),
      assistantToolCall("old-call", 2),
      toolResult("old-call", "read", "x".repeat(4_000), 3),
      assistantToolCall("older-call-2", 4),
      toolResult("older-call-2", "read", "y".repeat(4_000), 5),
      textMessage("user", "recent protected request", 6),
      textMessage("assistant", "live head", 7),
    ], state, cfg);

    const full = detectCompressionCandidate(pruned, state, cfg, 0.9);
    const minimal = detectCompressionCandidate(pruned, state, cfg, 0.9, { requiredSavingsTokens: 10 });

    expect(full).not.toBe(null);
    expect(minimal).not.toBe(null);
    expect(minimal!.messageCount).toBeLessThan(full!.messageCount);
    expect(state.messageMetaSnapshot.get(minimal!.endId)?.toolCallId).toBe("old-call");
    expect(minimal!.reason).toContain("minimal oldest protocol-safe prefix");
  });

  test("compression candidates are suppressed below configured context pressure", () => {
    const state = createState();
    const candidateConfig = config({
      compress: {
        autoCandidates: {
          enabled: true,
          minContextPercent: 0.40,
          keepRecentTurns: 1,
          minMessages: 2,
          minTokens: 0,
        },
        messageMode: {
          enabled: true,
          minContextPercent: 0.40,
          keepRecentTurns: 1,
          mediumTokens: 1,
          highTokens: 1000,
          maxSuggestions: 5,
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
        textMessage("user", "recent user", 3),
      ],
      state,
      candidateConfig,
    );

    expect(detectCompressionCandidate(pruned, state, candidateConfig, 0.39)).toBe(null);
    expect(detectMessageCompressionCandidates(pruned, state, candidateConfig, 0.39)).toEqual([]);
    expect(detectCompressionCandidate(pruned, state, candidateConfig, 0.40)).not.toBe(null);
    expect(detectMessageCompressionCandidates(pruned, state, candidateConfig, 0.40).map((item) => item.messageId)).toContain("m002");
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

    // Addressability now comes from the snapshot rebuilt by applyPruning
    // (mirroring how detectCompressionCandidate is used in production), not
    // from inline dcp-id tags. The malformed legacy tags below exercise that
    // the pruner stays robust to transcripts that still contain them.
    const pruned = applyPruning(
      [
        textMessage("user", "old user\n<dcp-id=m001</dcp-id>", 1),
        textMessage("assistant", "old assistant\n<dcp-id=m002</dcp-id>", 2),
        textMessage("user", "recent user\n<dcp-id=m003</dcp-id>", 3),
        textMessage("assistant", "recent assistant\n<dcp-id=m004</dcp-id>", 4),
      ],
      state,
      cfg,
    );

    const candidate = detectCompressionCandidate(pruned, state, cfg, 0.5);

    expect(candidate).not.toBe(null);
    expect(candidate?.startId).toBe("m001");
    expect(candidate?.endId).toBe("m002");
  });

  test("preserves signed assistant content even when it contains DCP-like text", () => {
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
    expect(asJson).toContain("m999");
    expect(asJson).toContain("hidden nudge");
    expect(asJson).not.toContain("[dcp-id]");
    expect(state.messageMetaSnapshot.get("m002")?.text).toContain("m999");

    const assistantTextBlock = (pruned[1].content as any[])[0];
    expect(assistantTextBlock?.textSignature).toBe("signed-original-text");
  });

  test("assistant metadata sanitizer is identity-only for signed provider content", () => {
    const assistant = {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "Done.\n[dcp-id]: # (m999)\n[dcp-block-id]: # (b9)\n<dcp-system-reminder>hidden nudge</dcp-system-reminder>",
          textSignature: "signed-original-text",
        },
        {
          type: "text",
          text: "```markdown\n[dcp-id]: # (m123)\n```",
          textSignature: "signed-code-example",
        },
      ],
      timestamp: 2,
    };
    const sanitized = stripStaleDcpMetadataFromAssistantMessage(assistant);

    expect(sanitized).toBe(assistant);
    const blocks = sanitized.content as any[];
    expect(blocks[0]?.text).toContain("hidden nudge");
    expect(blocks[0]?.textSignature).toBe("signed-original-text");
    expect(blocks[1]?.text).toContain("[dcp-id]: # (m123)");
    expect(blocks[1]?.textSignature).toBe("signed-code-example");
  });

  test("strips stale user/tool markers while preserving fenced DCP examples", () => {
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
    expect(asJson).not.toContain("m999");
    expect(asJson).toContain("m777");
    expect(asJson).not.toContain("m888");

    const candidate = detectCompressionCandidate(pruned, state, candidateConfig, 0.5);

    expect(candidate?.startId).toBe("m001");
  });

  test("compression candidates use current addressable ids when source text contains stale ids", () => {
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
        messageMode: {
          enabled: true,
          minContextPercent: 0.1,
          keepRecentTurns: 1,
          mediumTokens: 1,
          highTokens: 1000,
          maxSuggestions: 5,
        },
      } as any,
    });

    const pruned = applyPruning(
      [
        textMessage("user", "old user\n[dcp-id]: # (m999)", 1),
        textMessage("assistant", "old assistant " + "a".repeat(80) + "\n[dcp-id]: # (m998)", 2),
        textMessage("user", "recent", 3),
      ],
      state,
      candidateConfig,
    );

    const rangeCandidate = detectCompressionCandidate(pruned, state, candidateConfig, 0.5);
    const messageCandidates = detectMessageCompressionCandidates(pruned, state, candidateConfig, 0.5);

    expect(rangeCandidate?.startId).toBe("m001");
    expect(rangeCandidate?.endId).toBe("m002");
    expect(messageCandidates.map((candidate) => candidate.messageId)).toContain("m002");
    expect(messageCandidates.map((candidate) => candidate.messageId)).not.toContain("m998");
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

  test("compress tool keeps multi-range failures atomic when a later range hits an active block", async () => {
    const state = createState();
    const existing = block(1, 10, 20);
    state.compressionBlocks = [existing];
    state.nextBlockId = 2;
    for (const [id, timestamp] of [
      ["m001", 1],
      ["m002", 5],
      ["m003", 15],
      ["m004", 25],
    ] as const) {
      state.messageIdSnapshot.set(id, timestamp);
      state.messageMetaSnapshot.set(id, {
        timestamp,
        stableId: `id:${id}`,
        role: "assistant",
        tokenEstimate: 100,
      });
      state.messageIdsByStableId.set(`id:${id}`, id);
    }

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    await expect(registeredTool.execute(
      "tool-call",
      {
        topic: "Atomic ranges",
        ranges: [
          { startId: "m001", endId: "m002", summary: "first valid range" },
          { startId: "m003", endId: "m004", summary: "later partial overlap" },
        ],
      },
      undefined,
      undefined,
      { ui: { notify() {} } },
    )).rejects.toThrow(/partially overlaps/);

    expect(state.compressionBlocks).toEqual([existing]);
    expect(state.nextBlockId).toBe(2);
  });

  test("compress tool explains unknown non-mNNN IDs with current ID diagnostics", async () => {
    const state = createState();
    state.messageIdSnapshot.set("m001", 1);
    state.messageMetaSnapshot.set("m001", { timestamp: 1, role: "assistant" });
    state.compressionBlocks = [block(7, 10, 20)];

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    await expect(registeredTool.execute(
      "tool-call",
      { topic: "Stale", ranges: [{ startId: "xyz", endId: "m001", summary: "old" }] },
      undefined,
      undefined,
      { ui: { notify() {} } },
    )).rejects.toThrow(/Unknown message ID: xyz[\s\S]*Current raw message IDs: m001[\s\S]*Current active block IDs: b7 "Block 7"[\s\S]*use the corresponding bN block ID/i);

    expect(state.compressionBlocks).toHaveLength(1);
  });

  test("compress tool rejects unknown stable mNNN IDs instead of clamping", async () => {
    const state = createState();
    state.messageIdSnapshot.set("m001", 1);
    state.messageIdSnapshot.set("m002", 2);
    state.messageIdSnapshot.set("m003", 3);
    state.messageMetaSnapshot.set("m001", { timestamp: 1, role: "assistant", text: "first", tokenEstimate: 50 });
    state.messageMetaSnapshot.set("m002", { timestamp: 2, role: "assistant", text: "second", tokenEstimate: 50 });
    state.messageMetaSnapshot.set("m003", { timestamp: 3, role: "user", text: "third", tokenEstimate: 50 });

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    await expect(registeredTool.execute(
      "tool-call",
      { topic: "Unknown", ranges: [{ startId: "m001", endId: "m010", summary: "must not land" }] },
      undefined,
      undefined,
      { ui: { notify() {} } },
    )).rejects.toThrow(/Unknown message ID: m010/);

    expect(state.compressionBlocks).toHaveLength(0);
  });

  test("compress tool rejects when a stale startId has no valid forward clamp target", async () => {
    const state = createState();
    state.messageIdSnapshot.set("m001", 1);
    state.messageIdSnapshot.set("m002", 2);
    state.messageIdSnapshot.set("m003", 3);
    state.messageMetaSnapshot.set("m001", { timestamp: 1, role: "assistant", text: "first", tokenEstimate: 50 });
    state.messageMetaSnapshot.set("m002", { timestamp: 2, role: "assistant", text: "second", tokenEstimate: 50 });
    state.messageMetaSnapshot.set("m003", { timestamp: 3, role: "user", text: "third", tokenEstimate: 50 });

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    // Stable IDs never renumber, so an unknown boundary cannot be safely
    // inferred from its numeric suffix.
    await expect(registeredTool.execute(
      "tool-call",
      { topic: "Bad", ranges: [{ startId: "m010", endId: "m010", summary: "should not land" }] },
      undefined,
      undefined,
      { ui: { notify() {} } },
    )).rejects.toThrow(/Unknown message ID: m010/);

    expect(state.compressionBlocks).toHaveLength(0);
  });

  test("compress tool rolls up an active block when a stale mNNN resolves to its placeholder", async () => {
    const state = createState();
    // Active block b1 already covers an earlier range.
    const existing = block(1, 10, 12);
    existing.startMessageId = "stable-a";
    existing.endMessageId = "stable-b";
    state.compressionBlocks.push(existing);
    state.nextBlockId = 2;
    // m001 is the model-visible synthetic placeholder that represents b1.
    state.messageIdSnapshot.set("m001", 10);
    state.messageMetaSnapshot.set("m001", {
      timestamp: 10,
      role: "assistant",
      text: "[dcp-block-id]: # (b1)",
      tokenEstimate: 10,
      blockId: 1,
    });
    state.messageIdSnapshot.set("m002", 20);
    state.messageMetaSnapshot.set("m002", { timestamp: 20, role: "assistant", text: "later", tokenEstimate: 50 });

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    // startId m001 points at b1's placeholder. It must roll b1 up rather
    // than nest a new block on top of the synthetic placeholder.
    await registeredTool.execute(
      "tool-call",
      { topic: "Rollup", ranges: [{ startId: "m001", endId: "m002", summary: "rolled summary" }] },
      undefined,
      undefined,
      { ui: { notify() {} } },
    );

    expect(state.compressionBlocks.find((b) => b.id === 1 && b.active)).toBeUndefined();
    const rollup = state.compressionBlocks.find((b) => b.id === 2);
    expect(rollup?.active).toBe(true);
    expect(rollup?.coveredBlockIds).toEqual([1]);
  });

  test("compress tool throws on a stale mNNN with an empty snapshot and does not mutate state", async () => {
    const state = createState();
    // Empty snapshot: nothing addressable. Clamp would be guessing, so the
    // call must reject. Mirrors the real "Current raw message IDs: none" case.
    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    const result = registeredTool.execute(
      "tool-call",
      { topic: "Empty", ranges: [{ startId: "m001", endId: "m001", summary: "x" }] },
      undefined,
      undefined,
      { ui: { notify() {} } },
    );

    await expect(result).rejects.toThrow(/Unknown message ID: m001/);
    expect(state.compressionBlocks).toHaveLength(0);
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

  test("compress tool persists sidecar immediately after creating blocks", async () => {
    const state = createState();
    state.messageIdSnapshot.set("m001", 1);
    state.messageIdSnapshot.set("m002", 2);
    state.messageMetaSnapshot.set("m001", { timestamp: 1, role: "assistant", tokenEstimate: 200 });
    state.messageMetaSnapshot.set("m002", { timestamp: 2, role: "assistant", tokenEstimate: 200 });

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());

    const sessionDir = mkdtempSync(join(tmpdir(), "dcp-sidecar-"));
    const ctx = {
      sessionManager: {
        getSessionDir: () => sessionDir,
        getSessionId: () => "sidecar-session",
      },
      ui: { notify() {} },
    };

    await registeredTool.execute(
      "tool-call",
      { topic: "Sidecar", ranges: [{ startId: "m001", endId: "m002", summary: "sidecar summary" }] },
      undefined,
      undefined,
      ctx,
    );

    const persisted = readPersistedDcpPayloadSync(join(sessionDir, "dcp-state", "sidecar-session.json"));
    expect(persisted.compressionBlocks).toHaveLength(1);
    expect(persisted.compressionBlocks[0]).toMatchObject({
      id: 1,
      topic: "Sidecar",
      summary: "sidecar summary",
      active: true,
    });
    expect(persisted.nextBlockId).toBe(2);
  });

  test("compress tool retries with the same tool call id idempotently", async () => {
    const state = createState();
    state.messageIdSnapshot.set("m001", 1);
    state.messageIdSnapshot.set("m002", 2);
    state.messageMetaSnapshot.set("m001", { timestamp: 1, role: "assistant", tokenEstimate: 300 });
    state.messageMetaSnapshot.set("m002", { timestamp: 2, role: "assistant", tokenEstimate: 300 });

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, config());
    const params = {
      topic: "Retry-safe",
      ranges: [{ startId: "m001", endId: "m002", summary: "one durable result" }],
    };

    const first = await registeredTool.execute(
      "same-tool-call",
      params,
      undefined,
      undefined,
      { ui: { notify() {} } },
    );
    const nextBlockIdAfterFirst = state.nextBlockId;
    const second = await registeredTool.execute(
      "same-tool-call",
      params,
      undefined,
      undefined,
      { ui: { notify() {} } },
    );

    expect(first.details.blockIds).toEqual([1]);
    expect(second.details.blockIds).toEqual([1]);
    expect(second.details.idempotentReplay).toBe(true);
    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.nextBlockId).toBe(nextBlockIdAfterFirst);
    expect(state.compressionBlocks[0]?.createdByToolCallId).toBe("same-tool-call");
  });

  test("compress tool does not publish a late result after the session epoch changes", async () => {
    const state = createState();
    state.messageIdSnapshot.set("m001", 1);
    state.messageIdSnapshot.set("m002", 2);
    state.messageMetaSnapshot.set("m001", { timestamp: 1, role: "assistant", tokenEstimate: 300 });
    state.messageMetaSnapshot.set("m002", { timestamp: 2, role: "assistant", tokenEstimate: 300 });

    let registeredTool: any;
    registerCompressTool(
      { registerTool: (tool: any) => { registeredTool = tool } } as any,
      state,
      config(),
      {
        capturePersistenceTarget: () => ({ statePath: "/captured/old-session.json" }),
        saveStateToTarget: async () => {
          resetState(state);
        },
      },
    );
    const startingEpoch = state.sessionEpoch;

    await expect(registeredTool.execute(
      "late-tool-call",
      { topic: "Late", ranges: [{ startId: "m001", endId: "m002", summary: "must stay old" }] },
      undefined,
      undefined,
      { ui: { notify() {} } },
    )).rejects.toThrow(/stale|session changed/i);

    expect(state.sessionEpoch).toBe(startingEpoch + 1);
    expect(state.compressionBlocks).toHaveLength(0);
    expect(state.nextBlockId).toBe(1);
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

  test("range and message compression accept the first raw ID after a block with the same timestamp", async () => {
    const makeAdjacentState = () => {
      const state = createState();
      const existing = block(1, 1, 10);
      existing.startMessageId = "id:001";
      existing.endMessageId = "id:170";
      existing.anchorTimestamp = 10;
      existing.anchorMessageId = "id:171";
      state.compressionBlocks = [existing];
      state.nextBlockId = 2;

      for (const [stableId, visibleId] of [
        ["id:001", "m001"],
        ["id:170", "m170"],
        ["id:171", "m171"],
        ["id:172", "m172"],
        ["id:173", "m173"],
      ] as const) {
        state.messageIdsByStableId.set(stableId, visibleId);
      }
      state.messageIdSnapshot.set("m171", 10);
      state.messageIdSnapshot.set("m172", 11);
      state.messageIdSnapshot.set("m173", 11);
      state.messageMetaSnapshot.set("m171", {
        timestamp: 10,
        stableId: "id:171",
        role: "assistant",
        tokenEstimate: 100,
      });
      state.messageMetaSnapshot.set("m172", {
        timestamp: 11,
        stableId: "id:172",
        role: "assistant",
        tokenEstimate: 100,
      });
      state.messageMetaSnapshot.set("m173", {
        timestamp: 11,
        stableId: "id:173",
        role: "assistant",
        tokenEstimate: 900,
      });
      return state;
    };

    const rangeState = makeAdjacentState();
    let rangeTool: any;
    registerCompressTool(
      { registerTool: (tool: any) => { rangeTool = tool } } as any,
      rangeState,
      config(),
    );
    await rangeTool.execute(
      "range-after-block",
      {
        topic: "Adjacent range",
        ranges: [{ startId: "m171", endId: "m172", summary: "new adjacent work" }],
      },
      undefined,
      undefined,
      { ui: { notify() {} } },
    );
    expect(rangeState.compressionBlocks.find((entry) => entry.id === 1)?.active).toBe(true);
    expect(rangeState.compressionBlocks.find((entry) => entry.id === 2)).toMatchObject({
      startMessageId: "id:171",
      endMessageId: "id:172",
      anchorMessageId: "id:173",
      active: true,
    });

    const materialized = applyCompressionBlocks([
      { id: "001", role: "assistant", content: "old start", timestamp: 1 },
      { id: "170", role: "assistant", content: "old end", timestamp: 10 },
      { id: "171", role: "assistant", content: "adjacent start", timestamp: 10 },
      { id: "172", role: "assistant", content: "adjacent end", timestamp: 11 },
      { id: "173", role: "assistant", content: "live head must survive", timestamp: 11 },
    ], rangeState);
    expect(materialized.map(contentText)).toEqual([
      expect.stringContaining("[Compressed section: Block 1]"),
      expect.stringContaining("[Compressed section: Adjacent range]"),
      "live head must survive",
    ]);

    const messageState = makeAdjacentState();
    let messageTool: any;
    registerCompressTool(
      { registerTool: (tool: any) => { messageTool = tool } } as any,
      messageState,
      config(),
    );
    await messageTool.execute(
      "message-after-block",
      {
        topic: "Adjacent message",
        messages: [{ messageId: "m171", summary: "first free raw message" }],
      },
      undefined,
      undefined,
      { ui: { notify() {} } },
    );
    expect(messageState.compressionBlocks.find((entry) => entry.id === 2)).toMatchObject({
      startMessageId: "id:171",
      endMessageId: "id:171",
      mode: "message",
      active: true,
    });
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

    expect(JSON.stringify(visible)).not.toContain("[dcp-id]");
    expect(state.messageIdSnapshot.has("m001")).toBe(true);
    expect(JSON.stringify(visible)).toContain("Stable DCP IDs");
    expect(JSON.stringify(visible)).toContain("m001=this user message");

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

  test("message compression replaces only one tool-result body in a parallel group", async () => {
    const state = createState();
    const cfg = config();
    const assistant = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "parallel-a", name: "read", input: { path: "a.ts" } },
        { type: "toolCall", id: "parallel-b", name: "read", input: { path: "b.ts" } },
      ],
      timestamp: 2,
    };
    const rawMessages = [
      textMessage("user", "inspect both files", 1),
      assistant,
      toolResult("parallel-a", "read", "result a " + "a".repeat(200), 3),
      toolResult("parallel-b", "read", "SIBLING_FACT_B " + "b".repeat(200), 4),
      textMessage("user", "continue", 5),
    ];
    applyPruning(rawMessages, state, cfg);
    const resultId = [...state.messageMetaSnapshot.entries()]
      .find(([, meta]) => meta.toolCallId === "parallel-a")?.[0];
    expect(resultId).toBeDefined();

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, cfg);

    await registeredTool.execute(
      "tool-call",
      {
        topic: "One tool result",
        messages: [{ messageId: resultId!, summary: "only result a" }],
      },
      undefined,
      undefined,
      { ui: { notify() {} } },
    );

    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks[0]).toMatchObject({
      mode: "message",
      version: 2,
      replacementMode: "message-body",
    });

    const projected = applyPruning(rawMessages, state, cfg);
    expect(projected.find((message) => message.role === "assistant")).toEqual(assistant);
    const results = projected.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(2);
    expect(results.find((message) => message.toolCallId === "parallel-a")?.toolCallId).toBe("parallel-a");
    expect(contentText(results.find((message) => message.toolCallId === "parallel-a"))).toContain("only result a");
    expect(contentText(results.find((message) => message.toolCallId === "parallel-a"))).not.toContain("a".repeat(80));
    expect(contentText(results.find((message) => message.toolCallId === "parallel-b"))).toContain("SIBLING_FACT_B");
    expect([...state.messageMetaSnapshot.entries()].find(([, meta]) => meta.toolCallId === "parallel-a")?.[0]).toBe(resultId);

    applyPruning(rawMessages, state, cfg);
    expect([...state.messageMetaSnapshot.entries()].find(([, meta]) => meta.toolCallId === "parallel-a")?.[0]).toBe(resultId);
  });

  test("range compression rejects a selection that cuts through a parallel tool group", async () => {
    const state = createState();
    const cfg = config();
    applyPruning(
      [
        textMessage("user", "inspect both files", 1),
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "parallel-a", name: "read", input: { path: "a.ts" } },
            { type: "toolCall", id: "parallel-b", name: "read", input: { path: "b.ts" } },
          ],
          timestamp: 2,
        },
        toolResult("parallel-a", "read", "result a", 3),
        toolResult("parallel-b", "read", "result b", 4),
        textMessage("user", "continue", 5),
      ],
      state,
      cfg,
    );
    const assistantId = [...state.messageMetaSnapshot.entries()]
      .find(([, meta]) => meta.role === "assistant" && meta.toolCallIds?.includes("parallel-a"))?.[0];
    const resultAId = [...state.messageMetaSnapshot.entries()]
      .find(([, meta]) => meta.toolCallId === "parallel-a")?.[0];
    const resultBId = [...state.messageMetaSnapshot.entries()]
      .find(([, meta]) => meta.toolCallId === "parallel-b")?.[0];
    expect(assistantId).toBeDefined();
    expect(resultAId).toBeDefined();
    expect(resultBId).toBeDefined();

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, cfg);
    const nextBlockIdBefore = state.nextBlockId;

    await expect(registeredTool.execute(
      "tool-call",
      {
        topic: "Partial group",
        ranges: [{ startId: resultAId!, endId: resultAId!, summary: "too narrow" }],
      },
      undefined,
      undefined,
      { ui: { notify() {} } },
    )).rejects.toThrow(new RegExp(`protocol-safe closed range is ${assistantId}\\.\\.${resultBId}`, "i"));

    expect(state.compressionBlocks).toHaveLength(0);
    expect(state.nextBlockId).toBe(nextBlockIdBefore);
  });

  test("message compression refuses to edit signed assistant content in place", async () => {
    const state = createState();
    const cfg = config();
    const signedAssistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "provider reasoning", thinkingSignature: "sig-keep-exact" },
        { type: "text", text: "signed checkpoint" },
      ],
      timestamp: 2,
    };
    applyPruning(
      [
        textMessage("user", "older request", 1),
        signedAssistant,
        textMessage("user", "active request", 3),
      ],
      state,
      cfg,
    );
    const signedId = [...state.messageMetaSnapshot.entries()]
      .find(([, meta]) => meta.role === "assistant")?.[0];
    expect(signedId).toBeDefined();

    let registeredTool: any;
    registerCompressTool({ registerTool: (tool: any) => { registeredTool = tool } } as any, state, cfg);
    await expect(registeredTool.execute(
      "tool-call",
      { topic: "Signed", messages: [{ messageId: signedId!, summary: "must not replace signature" }] },
      undefined,
      undefined,
      { ui: { notify() {} } },
    )).rejects.toThrow(/signed assistant|cannot be edited/i);

    expect(state.compressionBlocks).toHaveLength(0);
    expect(state.nextBlockId).toBe(1);
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

    const candidates = detectMessageCompressionCandidates(pruned, state, cfg, 0.5);

    expect(candidates.map((candidate) => candidate.messageId)).toEqual(["m002", "m003"]);
    expect(candidates[0]?.priority).toBe("high");
    expect(candidates[1]?.priority).toBe("medium");
    expect(JSON.stringify(pruned)).not.toContain("[dcp-id]");
    expect(JSON.stringify(pruned)).toContain("m002=preceding assistant message");
    expect(state.messageMetaSnapshot.get("m002")?.priority).toBe("high");
  });

  test("message compression candidates preserve the active turn when there are fewer turns than keepRecentTurns", () => {
    const state = createState();
    const cfg = config({
      compress: {
        messageMode: {
          enabled: true,
          minContextPercent: 0.1,
          keepRecentTurns: 2,
          mediumTokens: 20,
          highTokens: 100,
          maxSuggestions: 5,
        },
      } as any,
    });
    const pruned = applyPruning(
      [
        textMessage("user", "active request", 1),
        assistantToolCall("active-read", 2),
        toolResult("active-read", "read", "live output " + "x".repeat(800), 3),
      ],
      state,
      cfg,
    );

    expect(detectMessageCompressionCandidates(pruned, state, cfg, 0.8)).toEqual([]);
  });

  test("message compression candidates suggest completed tool-result bodies but not tool-call assistants", () => {
    const state = createState();
    const cfg = config({
      compress: {
        messageMode: {
          enabled: true,
          minContextPercent: 0.1,
          keepRecentTurns: 1,
          mediumTokens: 20,
          highTokens: 100,
          maxSuggestions: 5,
        },
      } as any,
    });
    const pruned = applyPruning(
      [
        textMessage("user", "old request", 1),
        assistantToolCall("old-read", 2),
        toolResult("old-read", "read", "old output " + "x".repeat(800), 3),
        textMessage("user", "active request", 4),
      ],
      state,
      cfg,
    );

    const candidates = detectMessageCompressionCandidates(pruned, state, cfg, 0.8);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ role: "toolResult", priority: "high" });
    expect(state.messageMetaSnapshot.get(candidates[0]!.messageId)?.toolCallId).toBe("old-read");
  });

  test("emergency same-turn candidates preserve recent, unseen, user, and protected outputs", () => {
    const state = createState();
    const cfg = config({
      compress: { protectTags: true },
      protectedFilePatterns: ["**/.env"],
      strategies: {
        emergencyCurrentTurnPruning: {
          keepRecentToolPairs: 2,
          minOutputTokens: 100,
          maxSuggestions: 10,
        },
      },
    });
    const messages = [textMessage("user", "active request " + "u".repeat(5_000), 1)];
    const definitions = [
      { id: "eligible", tool: "read", input: { path: "/tmp/a.txt" }, text: "a".repeat(2_000), seen: true },
      { id: "protected-tool", tool: "write", input: { path: "/tmp/out.txt" }, text: "b".repeat(2_000), seen: true },
      { id: "protected-file", tool: "read", input: { path: "/tmp/.env" }, text: "c".repeat(2_000), seen: true },
      { id: "protected-tag", tool: "read", input: { path: "/tmp/tag.txt" }, text: `<protect>${"d".repeat(2_000)}</protect>`, seen: true },
      { id: "unseen", tool: "read", input: { path: "/tmp/new.txt" }, text: "e".repeat(2_000), seen: false },
      { id: "recent-1", tool: "read", input: { path: "/tmp/r1.txt" }, text: "f".repeat(2_000), seen: true },
      { id: "recent-2", tool: "read", input: { path: "/tmp/r2.txt" }, text: "g".repeat(2_000), seen: true },
    ];

    definitions.forEach((definition, index) => {
      const timestamp = 10 + index * 2;
      messages.push(assistantToolCall(definition.id, timestamp));
      messages.push(toolResult(definition.id, definition.tool, definition.text, timestamp + 1));
      state.toolCalls.set(
        definition.id,
        toolRecord(definition.id, definition.tool, `${definition.tool}::${definition.id}`, 500, 1, definition.input),
      );
      if (definition.seen) state.providerSeenToolIds.add(definition.id);
    });

    const providerMessages = applyPruning(messages, state, cfg);
    const selection = analyzeEmergencyCurrentTurn(providerMessages, state, cfg);
    const candidates = emergencyCurrentTurnMessageCandidates(selection, cfg);

    expect(selection.eligible.map((output) => output.toolCallId)).toEqual(["eligible"]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.role).toBe("toolResult");
    expect(candidates[0]?.messageId).toBeDefined();
    expect(selection.stats.preservedRecentPairs).toBe(2);
    expect(selection.stats.preservedUnseenPairs).toBe(1);
    expect(selection.stats.preservedProtectedPairs).toBe(3);

    pruneEmergencyCurrentTurn(selection, state, 100_000);
    expect(state.prunedToolIds).toEqual(new Set(["eligible"]));
    expect(state.prunedToolIds.has("unseen")).toBe(false);
    expect(providerMessages.map(contentText).join("\n")).toContain("active request");
  });

  test("emergency range candidate unblocks auto-compress inside a single marathon user turn", async () => {
    const state = createState();
    const cfg = config({
      compress: {
        maxContextPercent: 0.65,
        autoCandidates: {
          keepRecentTurns: 1,
          minMessages: 6,
          minTokens: 100,
        },
        autoCompress: {
          enabled: true,
          patience: 2,
          summarizerModel: [],
        },
      } as any,
      strategies: {
        emergencyCurrentTurnPruning: {
          keepRecentToolPairs: 8,
          minOutputTokens: 500,
        },
      },
    });
    const messages = [textMessage("user", "single autonomous task " + "u".repeat(11_000), 1)];
    for (let index = 0; index < 100; index++) {
      const id = `marathon-${index}`;
      const timestamp = 10 + index * 2;
      messages.push(assistantToolCall(id, timestamp));
      messages.push(toolResult(id, "read", `raw-${id}-` + "x".repeat(4_000), timestamp + 1));
      state.toolCalls.set(id, toolRecord(id, "read", `read::${id}`, 1_000, 1));
    }

    const providerMessages = applyPruning(messages, state, cfg);
    expect(state.providerSeenToolIds.size).toBe(0);
    expect(detectCompressionCandidate(providerMessages, state, cfg, 0.90)).toBe(null);

    const outputSelection = analyzeEmergencyCurrentTurn(providerMessages, state, cfg);
    expect(outputSelection.stats.totalPairs).toBe(100);
    expect(outputSelection.stats.eligiblePairs).toBe(0);
    expect(outputSelection.stats.preservedUnseenPairs).toBeGreaterThan(90);

    expect(detectEmergencyCompressionCandidate(
      providerMessages,
      state,
      cfg,
      0.65,
      0.65,
    )).toBe(null);
    expect(detectEmergencyCompressionCandidate(
      providerMessages,
      state,
      cfg,
      0.90,
      0.65,
    )).toBe(null);
    // The newest eight groups remain protected. Earlier groups become eligible
    // only after completed provider evidence, not merely because a later
    // assistant exists in the transcript.
    for (let index = 0; index < 92; index++) state.providerSeenToolIds.add(`marathon-${index}`);
    const emergencyCandidate = detectEmergencyCompressionCandidate(
      providerMessages,
      state,
      cfg,
      0.90,
      0.65,
    );
    expect(emergencyCandidate).not.toBe(null);
    expect(emergencyCandidate?.messageCount).toBeGreaterThan(0);
    expect(emergencyCandidate?.estimatedTokens).toBeGreaterThan(0);
    expect(emergencyCandidate?.reason).toContain("emergency same-turn provider-evidenced prefix");
    expect(state.messageMetaSnapshot.get(emergencyCandidate!.startId)?.role).not.toBe("user");

    state.consecutiveIgnoredStrongNudges = 3;
    expect(decideAutoCompress(state, cfg, 0.90, 0.65, emergencyCandidate)).toEqual({
      shouldFire: true,
      reason: "ignored-opportunities",
    });

    const autoResult = await createAutoCompressionBlock({
      candidate: emergencyCandidate!,
      topic: "Marathon fallback",
      state,
      config: cfg,
      messages: providerMessages,
    });
    expect(autoResult.summaryMode).toBe("programmatic");
    expect(autoResult.removedTokenEstimate).toBeGreaterThan(0);
    expect(state.compressionBlocks.find((entry) => entry.id === autoResult.blockId)).toMatchObject({
      active: true,
      topic: "Marathon fallback",
    });
  });

  test("disabled routine autoCandidates does not disable the emergency range safety planner", () => {
    const state = createState();
    const cfg = config({
      compress: {
        autoCandidates: {
          enabled: false, minContextPercent: 0.4, keepRecentTurns: 1, minMessages: 1, minTokens: 1,
        },
        autoCompress: { enabled: true, patience: 1, summarizerModel: [], timeoutMs: 1000 },
      } as any,
      strategies: {
        emergencyCurrentTurnPruning: {
          enabled: true, hardContextPercent: 0.82, targetContextPercent: 0.70, patience: 1,
          keepRecentToolPairs: 0, minOutputTokens: 1, maxSuggestions: 8, protectedTools: [],
        },
      },
    });
    const messages = [
      textMessage("user", "single task", 1),
      assistantToolCall("safe-1", 2),
      toolResult("safe-1", "read", "a".repeat(1000), 3),
      assistantToolCall("safe-2", 4),
      toolResult("safe-2", "read", "b".repeat(1000), 5),
      assistantToolCall("safe-3", 6),
      toolResult("safe-3", "read", "c".repeat(1000), 7),
    ];
    const projected = applyPruning(messages, state, cfg);
    state.providerSeenToolIds.add("safe-1");
    state.providerSeenToolIds.add("safe-2");

    expect(detectCompressionCandidate(projected, state, cfg, 0.9)).toBe(null);
    expect(detectEmergencyCompressionCandidate(projected, state, cfg, 0.9, 0.65)).not.toBe(null);
  });

  test("emergency range does not treat a later assistant as provider evidence for unseen results", () => {
    const state = createState();
    const cfg = config({
      compress: { autoCandidates: { enabled: true, minContextPercent: 0.1, keepRecentTurns: 1, minMessages: 1, minTokens: 1 } } as any,
      strategies: { emergencyCurrentTurnPruning: { enabled: true, keepRecentToolPairs: 0, minOutputTokens: 1 } as any },
    });
    const messages = [
      textMessage("user", "single task", 1),
      assistantToolCall("unseen-old", 2),
      toolResult("unseen-old", "read", "old result", 3),
      assistantToolCall("live-head", 4),
      toolResult("live-head", "read", "new result", 5),
    ];
    state.toolCalls.set("unseen-old", toolRecord("unseen-old", "read", "read::old", 100, 1));
    state.toolCalls.set("live-head", toolRecord("live-head", "read", "read::new", 100, 1));
    const projected = applyPruning(messages, state, cfg);

    expect(detectEmergencyCompressionCandidate(projected, state, cfg, 0.9, 0.65)).toBe(null);
    state.providerSeenToolIds.add("unseen-old");
    expect(detectEmergencyCompressionCandidate(projected, state, cfg, 0.9, 0.65)).not.toBe(null);
  });

  test("emergency hard pressure is independent of a higher model threshold", () => {
    expect(emergencyPressureState(0.85, 0.90, 0.82)).toEqual({
      hardEmergencyReached: true,
      contextLimitReached: false,
      emergencyPressureReached: true,
    });
    expect(emergencyPressureState(0.80, 0.90, 0.82).emergencyPressureReached).toBe(false);
  });

  test("disabled emergency pruning produces no same-turn candidates", () => {
    const state = createState();
    const cfg = config({
      strategies: {
        emergencyCurrentTurnPruning: {
          enabled: false,
          keepRecentToolPairs: 0,
          minOutputTokens: 1,
        },
      },
    });
    const messages = [
      textMessage("user", "active request", 1),
      assistantToolCall("disabled-pair", 2),
      toolResult("disabled-pair", "read", "x".repeat(4_000), 3),
    ];
    state.toolCalls.set("disabled-pair", toolRecord("disabled-pair", "read", "read::disabled", 1_000, 1));
    state.providerSeenToolIds.add("disabled-pair");

    const selection = analyzeEmergencyCurrentTurn(applyPruning(messages, state, cfg), state, cfg);
    expect(selection.eligible).toHaveLength(0);
    expect(emergencyCurrentTurnMessageCandidates(selection, cfg)).toHaveLength(0);
  });

  test("provider exposure requires tool-result evidence in the outgoing payload", () => {
    const record = toolRecord("call-1|item-1", "read", "read::call-1", 1_000, 1);
    record.outputText = "provider-visible output";

    expect(providerPayloadIncludesToolResult(
      collectProviderToolResultEvidence({
        input: [{ type: "function_call_output", call_id: "call-1", output: record.outputText }],
      }),
      record,
    )).toBe(true);
    expect(providerPayloadIncludesToolResult(
      collectProviderToolResultEvidence({
        contents: [{ parts: [{ functionResponse: {
          name: "read",
          response: {
            output: `${record.outputText}\n\n<dcp-message-ids>\nStable DCP IDs: m001\n</dcp-message-ids>`,
          },
        } }] }],
      }),
      record,
    )).toBe(true);
    expect(providerPayloadIncludesToolResult(
      collectProviderToolResultEvidence({ messages: [{ role: "user", content: "continue" }] }),
      record,
    )).toBe(false);
  });

  test("budget planner floors stale provider usage with the fresh repo projection", () => {
    const plan = planDcpBudget({
      providerUsageTokens: 30_000,
      repoProjectedTokens: 90_000,
      contextWindow: 100_000,
      reservedOutputTokens: 10_000,
      maxContextPercent: 0.65,
      hardContextPercent: 0.82,
      targetContextPercent: 0.60,
    });

    expect(plan.projectedBeforeTokens).toBe(90_000);
    expect(plan.projectionOrigin).toBe("repo-over-provider");
    expect(plan.inputCapacityTokens).toBe(90_000);
    expect(plan.hardPressure).toBe(true);
    expect(plan.requiredSavingsTokens).toBe(30_000);
  });

  test("budget planner falls back to repo projection and clips summaryBuffer to capacity", () => {
    const plan = planDcpBudget({
      providerUsageTokens: null,
      repoProjectedTokens: 70_000,
      contextWindow: 100_000,
      reservedOutputTokens: 30_000,
      reservedToolTokens: 5_000,
      maxContextPercent: 0.64,
      hardContextPercent: 0.90,
      targetContextPercent: 0.60,
      summaryBufferEnabled: true,
      activeSummaryTokens: 20_000,
      summaryBufferMaxBonusRatio: 0.10,
    });

    expect(plan.projectionOrigin).toBe("repo-fallback");
    expect(plan.inputCapacityTokens).toBe(65_000);
    expect(plan.summaryBufferTokensApplied).toBe(1_000);
    expect(plan.softHeadroomTokens).toBe(65_000);
    expect(plan.softHeadroomTokens).toBeLessThanOrEqual(plan.inputCapacityTokens);
    expect(plan.hardPressure).toBe(true);
  });

  test("blocked reason classifier distinguishes live head, unknown evidence, protected minimum, and exhausted budget", () => {
    const base = {
      pressured: true,
      candidateAvailable: false,
      messageCandidateCount: 0,
      requiredSavingsTokens: 2_000,
      capacityExceeded: true,
    };

    expect(inferDcpBlockedReason(base)).toBe("live-head-only");
    expect(inferDcpBlockedReason({ ...base, messageCandidateCount: 1 })).toBeUndefined();
    expect(inferDcpBlockedReason({
      ...base,
      emergencyStats: {
        totalPairs: 4, eligiblePairs: 0, eligibleRecoverableTokens: 0,
        preservedRecentPairs: 1, preservedUnseenPairs: 3, preservedProtectedPairs: 0,
      },
    })).toBe("evidence-unknown");
    expect(inferDcpBlockedReason({
      ...base,
      emergencyStats: {
        totalPairs: 4, eligiblePairs: 0, eligibleRecoverableTokens: 0,
        preservedRecentPairs: 1, preservedUnseenPairs: 0, preservedProtectedPairs: 3,
      },
    })).toBe("protected-budget-exceeded");
    expect(inferDcpBlockedReason({
      ...base,
      emergencyStats: {
        totalPairs: 4, eligiblePairs: 2, eligibleRecoverableTokens: 1_000,
        preservedRecentPairs: 2, preservedUnseenPairs: 0, preservedProtectedPairs: 0,
      },
    })).toBe("budget-exhausted");
  });

  test("progress controller exposes explicit normal, pressure, waiting, preparing, and blocked phases", () => {
    const base = {
      enabled: true,
      autoEnabled: true,
      pressure: true,
      candidateAvailable: true,
      ignoredOpportunities: 0,
      patience: 1,
    };

    expect(decideDcpProgress({ ...base, pressure: false })).toEqual({
      phase: "normal", shouldPrepare: false, reason: "below-pressure",
    });
    expect(decideDcpProgress({ ...base, autoEnabled: false })).toEqual({
      phase: "pressure", shouldPrepare: false, reason: "auto-disabled",
    });
    expect(decideDcpProgress({ ...base, candidateAvailable: false })).toEqual({
      phase: "awaiting_opportunity", shouldPrepare: false, reason: "no-candidate",
    });
    expect(decideDcpProgress({ ...base, ignoredOpportunities: 1 })).toEqual({
      phase: "awaiting_opportunity", shouldPrepare: false, reason: "below-patience",
    });
    expect(decideDcpProgress({ ...base, ignoredOpportunities: 2 })).toEqual({
      phase: "preparing", shouldPrepare: true, reason: "ignored-opportunities",
    });
    expect(decideDcpProgress({ ...base, blockedReason: "protected-budget-exceeded" })).toEqual({
      phase: "blocked",
      shouldPrepare: false,
      reason: "protected-budget-exceeded",
      blockedReason: "protected-budget-exceeded",
    });
  });

  test("progress controller exposes committed, cooldown, and degraded terminal phases", () => {
    const base = {
      enabled: true,
      autoEnabled: true,
      pressure: true,
      candidateAvailable: true,
      ignoredOpportunities: 5,
      patience: 1,
    };
    expect(decideDcpProgress({ ...base, justCommitted: true }).phase).toBe("committed");
    expect(decideDcpProgress({ ...base, cooldown: true }).phase).toBe("cooldown");
    expect(decideDcpProgress({ ...base, degradedReason: "evidence unavailable" })).toEqual({
      phase: "degraded", shouldPrepare: false, reason: "evidence unavailable",
    });
  });

  test("provider evidence tracker promotes identical retries only after a successful terminal message", () => {
    const tracker = new ProviderEvidenceTracker();
    const payload = { messages: [{ role: "tool", tool_call_id: "retry-pair", content: "visible" }] };
    const attempt = {
      sessionEpoch: 7,
      provider: "test-provider",
      model: "test-model",
      contentRevision: providerPayloadRevision(payload),
      statePath: "/tmp/retry-state.json",
      toolIds: new Set(["retry-pair"]),
      opportunityAvailable: true,
    };

    expect(tracker.begin(attempt).attempts).toBe(1);
    expect(tracker.begin(attempt).attempts).toBe(2);
    const completion = tracker.complete({
      sessionEpoch: 7,
      provider: "test-provider",
      model: "test-model",
      stopReason: "stop",
    });

    expect(completion.status).toBe("promote");
    if (completion.status === "promote") {
      expect(completion.attempts).toBe(2);
      expect([...completion.toolIds]).toEqual(["retry-pair"]);
      expect(completion.statePath).toBe("/tmp/retry-state.json");
      expect(completion.opportunityAvailable).toBe(true);
    }
  });

  test("provider evidence tracker refuses aborted streams and consumes the pending attempt", () => {
    const tracker = new ProviderEvidenceTracker();
    tracker.begin({
      sessionEpoch: 3,
      provider: "test-provider",
      model: "test-model",
      contentRevision: providerPayloadRevision({ input: "request" }),
      toolIds: new Set(["abort-pair"]),
    });

    expect(tracker.complete({
      sessionEpoch: 3,
      provider: "test-provider",
      model: "test-model",
      stopReason: "aborted",
    })).toEqual({ status: "refused", reason: "terminal-failure", attempts: 1 });
    expect(tracker.complete({
      sessionEpoch: 3,
      provider: "test-provider",
      model: "test-model",
      stopReason: "stop",
    })).toEqual({ status: "refused", reason: "no-pending", attempts: 0 });
  });

  test("provider evidence tracker refuses interleaved main and summarizer-shaped requests without a request id", () => {
    const tracker = new ProviderEvidenceTracker();
    tracker.begin({
      sessionEpoch: 11,
      provider: "main-provider",
      model: "main-model",
      contentRevision: providerPayloadRevision({ messages: [{ role: "tool", tool_call_id: "main-pair" }] }),
      statePath: "/tmp/main-state.json",
      toolIds: new Set(["main-pair"]),
    });
    const pending = tracker.begin({
      sessionEpoch: 11,
      provider: "summary-provider",
      model: "summary-model",
      contentRevision: providerPayloadRevision({ messages: [{ role: "user", content: "summarize" }] }),
      statePath: "/tmp/main-state.json",
      toolIds: new Set(),
    });

    expect(pending.ambiguous).toBe(true);
    expect(tracker.complete({
      sessionEpoch: 11,
      provider: "main-provider",
      model: "main-model",
      stopReason: "toolUse",
    })).toEqual({ status: "refused", reason: "ambiguous", attempts: 2 });
  });

  test("provider evidence tracker treats changed content on the same model as ambiguous interleaving", () => {
    const tracker = new ProviderEvidenceTracker();
    const base = {
      sessionEpoch: 5,
      provider: "test-provider",
      model: "test-model",
      toolIds: new Set(["pair"]),
    };
    tracker.begin({ ...base, contentRevision: providerPayloadRevision({ input: "first" }) });
    tracker.begin({ ...base, contentRevision: providerPayloadRevision({ input: "second" }) });

    expect(tracker.complete({
      sessionEpoch: 5,
      provider: "test-provider",
      model: "test-model",
      stopReason: "stop",
    })).toEqual({ status: "refused", reason: "ambiguous", attempts: 2 });
  });

  test("emergency analysis excludes bashExecution messages that cannot be placeholder-pruned", () => {
    const state = createState();
    const cfg = config({
      strategies: {
        emergencyCurrentTurnPruning: {
          keepRecentToolPairs: 0,
          minOutputTokens: 1,
        },
      },
    });
    const messages = [
      textMessage("user", "active request", 1),
      assistantToolCall("bash-pair", 2),
      {
        role: "bashExecution",
        toolCallId: "bash-pair",
        toolName: "shell",
        content: "x".repeat(4_000),
        timestamp: 3,
      },
    ];
    state.toolCalls.set("bash-pair", toolRecord("bash-pair", "shell", "shell::bash-pair", 1_000, 1));
    state.providerSeenToolIds.add("bash-pair");

    const selection = analyzeEmergencyCurrentTurn(applyPruning(messages, state, cfg), state, cfg);
    expect(selection.eligible).toHaveLength(0);
    expect(selection.stats.totalPairs).toBe(0);
  });

  test("emergency pruning stops at its budget and preserves tool-call/result validity", () => {
    const state = createState();
    const cfg = config({
      strategies: {
        emergencyCurrentTurnPruning: {
          keepRecentToolPairs: 2,
          minOutputTokens: 100,
        },
      },
    });
    const messages = [textMessage("user", "keep this user request", 1)];
    for (let index = 0; index < 6; index++) {
      const id = `pair-${index}`;
      const timestamp = 10 + index * 2;
      messages.push(assistantToolCall(id, timestamp));
      messages.push(toolResult(id, "read", `raw-${id}-` + "x".repeat(4_000), timestamp + 1));
      state.toolCalls.set(id, toolRecord(id, "read", `read::${id}`, 1_000, 1));
      state.providerSeenToolIds.add(id);
    }

    const before = applyPruning(messages, state, cfg);
    const beforeTokens = before.reduce((sum, message) => sum + estimateTokens(contentText(message)), 0);
    const selection = analyzeEmergencyCurrentTurn(before, state, cfg);
    expect(selection.eligible.map((output) => output.toolCallId)).toEqual([
      "pair-0",
      "pair-1",
      "pair-2",
      "pair-3",
    ]);

    const pruned = pruneEmergencyCurrentTurn(selection, state, 1_500);
    expect(pruned.prunedToolCallIds).toEqual(["pair-0", "pair-1"]);
    expect(pruned.estimatedTokensRecovered).toBe(
      selection.eligible[0]!.recoverableTokens + selection.eligible[1]!.recoverableTokens,
    );

    const after = applyPruning(messages, state, cfg);
    const afterTokens = after.reduce((sum, message) => sum + estimateTokens(contentText(message)), 0);
    expect(afterTokens).toBeLessThan(beforeTokens);
    expect(contentText(after.find((message) => message.toolCallId === "pair-0"))).toContain("current-turn context emergency");
    expect(contentText(after.find((message) => message.toolCallId === "pair-2"))).toContain("raw-pair-2");
    expect(contentText(after.find((message) => message.toolCallId === "pair-5"))).toContain("raw-pair-5");
    expect(after.map(contentText).join("\n")).toContain("keep this user request");

    const assistantIds = new Set(after
      .filter((message) => message.role === "assistant")
      .flatMap((message) => (message.content ?? [])
        .filter((part: any) => part?.type === "toolCall")
        .map((part: any) => part.id)));
    const resultIds = new Set(after
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolCallId));
    expect(assistantIds).toEqual(resultIds);
  });

  test("new rollups carry protected fragments once without recursively expanding the old summary", () => {
    const state = createState();
    const cfg = config({ compress: { protectUserMessages: true } as any });
    state.messageIdSnapshot.set("m001", 1);
    state.messageMetaSnapshot.set("m001", {
      timestamp: 1,
      stableId: "id:protected-user",
      role: "user",
      text: "MUST_KEEP_EXACT_CONSTRAINT",
      tokenEstimate: 20,
    });

    const first = createRangeCompressionBlock({
      topic: "First",
      summary: "OLD_VERBATIM_SUMMARY_BODY " + "x".repeat(500),
      startTimestamp: 1,
      endTimestamp: 1,
      startMessageId: "id:protected-user",
      endMessageId: "id:protected-user",
      anchorTimestamp: 2,
      state,
      config: cfg,
      version: 2,
      replacementMode: "range",
    }).block;
    expect(first.protectedFragments).toHaveLength(1);
    expect(first.protectedFragments?.[0]?.text).toBe("MUST_KEEP_EXACT_CONSTRAINT");
    expect(first.protectedFragments?.[0]?.hash).toMatch(/^[0-9a-f]{64}$/);

    state.messageIdSnapshot.clear();
    state.messageMetaSnapshot.clear();
    const second = createRangeCompressionBlock({
      topic: "Second",
      summary: "Decision: retained meaning from the prior block.",
      startTimestamp: 1,
      endTimestamp: 1,
      anchorTimestamp: 2,
      state,
      config: cfg,
      version: 2,
      replacementMode: "range",
      validatePlaceholders: false,
      expandPlaceholders: false,
    }).block;

    expect(second.coveredBlockIds).toEqual([first.id]);
    expect(second.summary).toContain("MUST_KEEP_EXACT_CONSTRAINT");
    expect(second.summary).not.toContain("OLD_VERBATIM_SUMMARY_BODY");
    expect(second.summary.match(/MUST_KEEP_EXACT_CONSTRAINT/g)).toHaveLength(1);
    expect(second.protectedFragments).toHaveLength(1);
    expect(second.protectedFragments?.[0]?.origin).toBe(first.protectedFragments?.[0]?.origin);
  });

  test("legacy rollups without a protected-fragment ledger retain verbatim expansion", () => {
    const state = createState();
    const legacy = block(1, 1, 1);
    legacy.summary = "LEGACY_SUMMARY_MUST_NOT_DISAPPEAR";
    legacy.protectedFragments = undefined;
    state.compressionBlocks = [legacy];
    state.nextBlockId = 2;

    const rolled = createRangeCompressionBlock({
      topic: "Legacy rollup",
      summary: "new summary without explicit placeholder",
      startTimestamp: 1,
      endTimestamp: 1,
      anchorTimestamp: 2,
      state,
      config: config(),
      version: 2,
      replacementMode: "range",
    }).block;

    expect(rolled.summary).toContain("LEGACY_SUMMARY_MUST_NOT_DISAPPEAR");
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

  test("compression block sync keeps blocks active when origin compress call is pruned", () => {
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

    // The block should remain active — the compress tool-call that created it
    // being pruned is not a reason to deactivate; the block's content is the
    // summary, not the tool-call.
    expect(state.compressionBlocks[0]?.active).toBe(true);
    expect(state.compressionBlocks[0]?.deactivatedReason).toBeUndefined();
    // The original message should be replaced by the compressed summary
    expect(JSON.stringify(pruned)).toContain("Compressed section");
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
        { cwd, ui: { notify() {} } },
      );
    } finally {
      process.chdir(previousCwd);
    }

    const summary = state.compressionBlocks[0]?.summary ?? "";
    expect(summary).toContain("compact subagent summary");
    expect(summary).toContain("full subagent result body");
  });

  test("protected subagent artifact recovery rejects symlinks outside the session cwd atomically", async () => {
    const state = createState();
    const cwd = mkdtempSync(join(tmpdir(), "dcp-subagent-symlink-root-"));
    const outside = mkdtempSync(join(tmpdir(), "dcp-subagent-symlink-outside-"));
    const agentDir = join(cwd, ".pi", "subagents", "run", "agent-1");
    mkdirSync(agentDir, { recursive: true });
    const outsideFile = join(outside, "result.md");
    writeFileSync(outsideFile, "outside secret body");
    symlinkSync(outsideFile, join(agentDir, "result.md"));

    state.messageIdSnapshot.set("m001", 1);
    state.messageMetaSnapshot.set("m001", {
      timestamp: 1,
      role: "toolResult",
      toolCallId: "call-sub-symlink",
      toolName: "subagents",
      text: "compact result",
      tokenEstimate: 50,
    });
    state.toolCalls.set("call-sub-symlink", {
      ...toolRecord("call-sub-symlink", "subagents", "subagents::{}", 50),
      outputText: "compact result\nFull result: .pi/subagents/run/agent-1/result.md",
      outputDetails: { artifacts: { resultMd: ".pi/subagents/run/agent-1/result.md" } },
    });

    let registeredTool: any;
    registerCompressTool(
      { registerTool: (tool: any) => { registeredTool = tool } } as any,
      state,
      config({ compress: { protectedTools: ["subagents"] } as any }),
    );
    await expect(registeredTool.execute(
      "tool-call",
      { topic: "Protected Tool", ranges: [{ startId: "m001", endId: "m001", summary: "tool summary" }] },
      undefined,
      undefined,
      { cwd, ui: { notify() {} } },
    )).rejects.toThrow(/outside the session cwd/i);
    expect(state.compressionBlocks).toHaveLength(0);
  });

  test("protected subagent artifact recovery refuses oversized files instead of truncating them", async () => {
    const state = createState();
    const cwd = mkdtempSync(join(tmpdir(), "dcp-subagent-large-"));
    const agentDir = join(cwd, ".pi", "subagents", "run", "agent-1");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "result.md"), "x".repeat(60_000));

    state.messageIdSnapshot.set("m001", 1);
    state.messageMetaSnapshot.set("m001", {
      timestamp: 1,
      role: "toolResult",
      toolCallId: "call-sub-large",
      toolName: "subagents",
      text: "compact result",
      tokenEstimate: 50,
    });
    state.toolCalls.set("call-sub-large", {
      ...toolRecord("call-sub-large", "subagents", "subagents::{}", 50),
      outputText: "compact result\nFull result: .pi/subagents/run/agent-1/result.md",
      outputDetails: { artifacts: { resultMd: ".pi/subagents/run/agent-1/result.md" } },
    });

    let registeredTool: any;
    registerCompressTool(
      { registerTool: (tool: any) => { registeredTool = tool } } as any,
      state,
      config({ compress: { protectedTools: ["subagents"] } as any }),
    );
    await expect(registeredTool.execute(
      "tool-call",
      { topic: "Protected Tool", ranges: [{ startId: "m001", endId: "m001", summary: "tool summary" }] },
      undefined,
      undefined,
      { cwd, ui: { notify() {} } },
    )).rejects.toThrow(/artifact exceeds|recovery budget/i);
    expect(state.compressionBlocks).toHaveLength(0);
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

  test("/dcp decompress refuses a modern block when exact raw source boundaries are unavailable", async () => {
    const state = createState();
    state.compressionBlocks = [{
      ...block(1, 10, 20),
      version: 2,
      replacementMode: "range",
      startMessageId: "id:source-a",
      endMessageId: "id:source-b",
    }];

    let command: any;
    const pi = { registerCommand(_name: string, registered: any) { command = registered }, sendMessage() {} } as any;
    const notifications: string[] = [];
    const ctx = {
      ui: { notify(message: string) { notifications.push(message) } },
      sessionManager: { getBranch: () => [{ type: "message", id: "source-a", message: textMessage("user", "only start survives", 10) }] },
    } as any;
    registerCommands(pi, state, config());

    await command.handler("decompress 1", ctx);
    expect(state.compressionBlocks[0]?.active).toBe(true);
    expect(state.compressionBlocks[0]?.deactivatedByUser).not.toBe(true);
    expect(notifications.join("\n")).toContain("raw source is unavailable");
  });

  test("/dcp decompress and recompress preserve inactive rollup descendants when exact raw source exists", async () => {
    const state = createState();
    state.compressionBlocks = [
      { ...block(1, 10, 20), active: false, version: 2, replacementMode: "range", startMessageId: "id:a", endMessageId: "id:b" },
      { ...block(2, 10, 40), version: 2, replacementMode: "range", startMessageId: "id:a", endMessageId: "id:d", coveredBlockIds: [1] },
    ];
    let command: any;
    const pi = { registerCommand(_name: string, registered: any) { command = registered }, sendMessage() {} } as any;
    const notifications: string[] = [];
    const branch = [
      { type: "message", id: "a", message: textMessage("user", "a", 10) },
      { type: "message", id: "b", message: textMessage("assistant", "b", 20) },
      { type: "message", id: "d", message: textMessage("assistant", "d", 40) },
    ];
    const ctx = { ui: { notify(message: string) { notifications.push(message) } }, sessionManager: { getBranch: () => branch } } as any;
    registerCommands(pi, state, config());

    await command.handler("decompress 2", ctx);
    expect(state.compressionBlocks.map((item) => item.active)).toEqual([false, false]);
    expect(state.compressionBlocks[1]?.deactivatedReason).toBe("user");

    await command.handler("recompress 2", ctx);
    expect(state.compressionBlocks.map((item) => item.active)).toEqual([false, true]);
    expect(state.compressionBlocks[1]?.deactivatedByUser).toBe(false);
    expect(state.compressionBlocks[1]?.deactivatedReason).toBeUndefined();
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

  test("DCP distributes stable IDs over user carriers without touching assistant messages", async () => {
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
          textMessage("user", "visible user content", 1),
          textMessage("assistant", "visible assistant content", 2),
          textMessage("user", "next user content", 3),
        ],
      },
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        getContextUsage: () => ({ tokens: 10, contextWindow: 10_000, percent: 0.1 }),
      },
    ) as { messages: any[] } | undefined;

    const messages = result?.messages ?? [];
    expect(contentText(messages[0])).toContain("m001=this user message");
    expect(contentText(messages[1])).toBe("visible assistant content");
    expect(contentText(messages[1])).not.toContain("<dcp-message-ids>");
    expect(contentText(messages[2])).toContain("m002=preceding assistant message");
    expect(contentText(messages[2])).toContain("m003=this user message");
  });

  test("DCP provider hook does not move message-ID metadata to the payload tail", async () => {
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
    const providerHandler = handlers.get("before_provider_request")?.[0];
    expect(contextHandler).toBeDefined();
    expect(providerHandler).toBeDefined();

    await contextHandler?.(
      {
        type: "context",
        messages: [
          textMessage("user", "visible user content", 1),
          textMessage("assistant", "visible assistant content", 2),
        ],
      },
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        getContextUsage: () => ({ tokens: 10, contextWindow: 10_000, percent: 0.1 }),
      },
    );

    const originalPayload = {
      messages: [
        { role: "system", content: "base system" },
        { role: "user", content: "visible user content" },
      ],
    };
    const payload = await providerHandler?.(
      { type: "before_provider_request", payload: originalPayload },
      { hasUI: false, sessionManager: { getBranch: () => [] } },
    ) as any;

    expect(payload).toBeUndefined();
    expect(originalPayload.messages[0]?.content).toBe("base system");
    expect(originalPayload.messages[1]?.content).toBe("visible user content");
  });

  test("DCP leaves Responses function_call_output payload items unchanged", async () => {
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
    const providerHandler = handlers.get("before_provider_request")?.[0];
    await contextHandler?.(
      {
        type: "context",
        messages: [textMessage("user", "inspect", 1), textMessage("assistant", "calling tool", 2)],
      },
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        getContextUsage: () => ({ tokens: 10, contextWindow: 10_000, percent: 0.1 }),
      },
    );

    const originalPayload = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }] },
        { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "tool result" },
      ],
    };
    const payload = await providerHandler?.(
      { type: "before_provider_request", payload: originalPayload },
      { hasUI: false, sessionManager: { getBranch: () => [] } },
    ) as any;

    expect(payload).toBeUndefined();
    expect(originalPayload.input[2]).toEqual({
      type: "function_call_output",
      call_id: "c1",
      output: "tool result",
    });
  });

  test("DCP keeps persistent IDs stable, monotonic, and collision-safe", () => {
    const state = createState();
    const firstMessages = [
      textMessage("user", "first", 1),
      textMessage("assistant", "answer", 2),
      textMessage("user", "second", 3),
    ];
    const first = applyPruning(firstMessages, state, config());
    const firstSecondCarrier = contentText(first[2]);

    const second = applyPruning([
      textMessage("assistant", "answer", 2),
      textMessage("user", "second", 3),
      textMessage("user", "third", 4),
    ], state, config());

    expect([...state.messageIdSnapshot.keys()]).toEqual(["m002", "m003", "m004"]);
    expect(contentText(second[1])).toBe(firstSecondCarrier);
    expect(contentText(second[2])).toContain("m004=this user message");

    const collisions = [textMessage("user", "a", 9), textMessage("user", "b", 9)];
    const collisionKeys = stableMessageKeys(collisions);
    expect(collisionKeys[0]).toStartWith("ts:9:");
    expect(collisionKeys[1]).toStartWith("ts:9:");
    expect(collisionKeys[0]).not.toBe(collisionKeys[1]);
    applyPruning(collisions, state, config());
    const secondCollisionId = state.messageIdsByStableId.get(collisionKeys[1]!);
    expect(state.messageIdsByStableId.get(collisionKeys[0]!)).not.toBe(secondCollisionId);

    applyPruning([textMessage("user", "b", 9)], state, config());
    expect(state.messageIdsByStableId.get(stableMessageKeys([textMessage("user", "b", 9)])[0]!))
      .toBe(secondCollisionId);
  });

  test("same-timestamp messages resolve to distinct compression candidates", () => {
    const state = createState();
    const cfg = config({
      compress: {
        messageMode: {
          enabled: true,
          minContextPercent: 0.1,
          keepRecentTurns: 1,
          mediumTokens: 1,
          highTokens: 5000,
          maxSuggestions: 10,
        },
      } as any,
    });
    const messages = [
      textMessage("user", "inspect", 1),
      textMessage("assistant", "first same-time answer", 9),
      textMessage("assistant", "second same-time answer", 9),
      textMessage("user", "recent", 10),
    ];

    const pruned = applyPruning(messages, state, cfg);
    const resultIds = detectMessageCompressionCandidates(pruned, state, cfg, 0.5)
      .filter((candidate) => candidate.role === "assistant")
      .map((candidate) => candidate.messageId);
    const expectedIds = [...state.messageMetaSnapshot]
      .filter(([, meta]) => meta.role === "assistant")
      .map(([id]) => id);

    expect(new Set(resultIds)).toEqual(new Set(expectedIds));
    expect(new Set(resultIds).size).toBe(2);
  });

  test("modern candidate snapshots never timestamp-match an unpublished assistant", () => {
    const state = createState();
    const cfg = config({
      compress: {
        messageMode: {
          enabled: true,
          minContextPercent: 0.1,
          keepRecentTurns: 1,
          mediumTokens: 1,
          highTokens: 5000,
          maxSuggestions: 10,
        },
      } as any,
    });
    const messages = [
      textMessage("user", "old request", 1),
      textMessage("assistant", "published assistant output", 9),
      textMessage("assistant", "unpublished assistant output", 9),
      textMessage("user", "recent request", 10),
    ];
    const stableKeys = stableMessageKeys(messages);
    for (const [id, index] of [["m001", 0], ["m002", 1], ["m003", 3]] as const) {
      const message = messages[index];
      state.messageIdSnapshot.set(id, message.timestamp);
      state.messageMetaSnapshot.set(id, {
        timestamp: message.timestamp,
        stableId: stableKeys[index],
        role: message.role,
        tokenEstimate: 10,
      });
    }

    const candidates = detectMessageCompressionCandidates(messages, state, cfg, 0.5);

    expect(candidates).toContainEqual(
      expect.objectContaining({ messageId: "m002", role: "assistant" }),
    );
    expect(candidates.filter((candidate) => candidate.role === "assistant")).toHaveLength(1);
    expect(new Set(candidates.map((candidate) => candidate.messageId)).size).toBe(candidates.length);
  });

  test("DCP context transforms preserve strict append-only continuation", () => {
    const state = createState();
    const cfg = config();
    const user = textMessage("user", "inspect", 1);
    const responseOne = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "signed reasoning one", thinkingSignature: "sig-one" },
        { type: "toolCall", id: "c1", name: "read", input: { path: "a.ts" } },
      ],
      timestamp: 2,
    };
    const resultOne = toolResult("c1", "read", "result one", 3);

    const requestOne = applyPruning([user], state, cfg);
    expect([...state.messageIdSnapshot.keys()]).toEqual(["m001"]);
    const requestTwo = applyPruning([user, responseOne, resultOne], state, cfg);
    expect([...state.messageIdSnapshot.keys()]).toEqual(["m001", "m002", "m003"]);
    expect(JSON.stringify(requestTwo.slice(0, 2))).toBe(
      JSON.stringify([...requestOne, responseOne]),
    );
    expect(contentText(requestTwo[1])).not.toContain("<dcp-message-ids>");

    const responseTwo = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "signed reasoning two", thinkingSignature: "sig-two" },
        { type: "toolCall", id: "c2", name: "read", input: { path: "b.ts" } },
      ],
      timestamp: 4,
    };
    const resultTwo = toolResult("c2", "read", "result two", 5);
    const requestThree = applyPruning(
      [user, responseOne, resultOne, responseTwo, resultTwo],
      state,
      cfg,
    );

    expect(JSON.stringify(requestThree.slice(0, 4))).toBe(
      JSON.stringify([...requestTwo, responseTwo]),
    );
    expect(requestThree[1]?.content[0]?.thinkingSignature).toBe("sig-one");
    expect(requestThree[3]?.content[0]?.thinkingSignature).toBe("sig-two");
  });

  test("two continuations after an intentional v2 rewrite preserve the rewritten prefix and assistant bytes", () => {
    const state = createState();
    const cfg = config({
      strategies: {
        deduplication: { enabled: false, protectedTools: [] },
        purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        autoToolPruning: { enabled: false, maxOutputTokens: 2000, keepRecentTurns: 2, readLikeTools: [], readLikeTurns: 3, protectedTools: [] },
      },
    });
    const model = {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      api: "openai-codex-responses",
      input: ["text"],
      reasoning: true,
      compat: {},
    } as any;
    const toResponsesInput = (messages: any[]) => convertResponsesMessages(
      model,
      { systemPrompt: "", messages, tools: [] } as any,
      new Set(["openai-codex"]),
    );

    const rawBase = [
      textMessage("user", "older request", 1),
      assistantToolCall("old-read", 2),
      toolResult("old-read", "read", "old raw output", 3),
      textMessage("user", "active request", 4),
    ];
    applyPruning(rawBase, state, cfg);
    const startMeta = state.messageMetaSnapshot.get("m002")!;
    const endMeta = state.messageMetaSnapshot.get("m003")!;
    createRangeCompressionBlock({
      topic: "Intentional rewrite",
      summary: "Old read was completed and is no longer needed verbatim.",
      startTimestamp: startMeta.timestamp,
      endTimestamp: endMeta.timestamp,
      startMessageId: startMeta.stableId,
      endMessageId: endMeta.stableId,
      state,
      config: cfg,
      mode: "range",
      version: 2,
      replacementMode: "range",
    });

    const rewritten = applyPruning(rawBase, state, cfg);
    expect(JSON.stringify(rewritten)).toContain("Intentional rewrite");
    expect(JSON.stringify(rewritten)).not.toContain("old raw output");
    const rewrittenPayload = toResponsesInput(rewritten);

    const responseOne = {
      role: "assistant",
      provider: model.provider,
      api: model.api,
      model: model.id,
      stopReason: "stop",
      usage: {},
      content: [{ type: "text", text: "first continuation", textSignature: "sig-cont-1" }],
      timestamp: 5,
    };
    const passOne = applyPruning([...rawBase, responseOne], state, cfg);
    expect(JSON.stringify(passOne.slice(0, rewritten.length))).toBe(JSON.stringify(rewritten));
    expect(JSON.stringify(passOne[passOne.length - 1])).toBe(JSON.stringify(responseOne));
    const payloadOne = toResponsesInput(passOne);
    expect(JSON.stringify(payloadOne.slice(0, rewrittenPayload.length))).toBe(JSON.stringify(rewrittenPayload));

    const responseTwo = {
      role: "assistant",
      provider: model.provider,
      api: model.api,
      model: model.id,
      stopReason: "stop",
      usage: {},
      content: [{ type: "text", text: "second continuation", textSignature: "sig-cont-2" }],
      timestamp: 6,
    };
    const passTwo = applyPruning([...rawBase, responseOne, responseTwo], state, cfg);
    expect(JSON.stringify(passTwo.slice(0, passOne.length))).toBe(JSON.stringify(passOne));
    expect(JSON.stringify(passTwo[passTwo.length - 1])).toBe(JSON.stringify(responseTwo));
    const payloadTwo = toResponsesInput(passTwo);
    expect(JSON.stringify(payloadTwo.slice(0, payloadOne.length))).toBe(JSON.stringify(payloadOne));
  });

  test("OpenAI Responses payload conversion preserves the append-only prefix", () => {
    const state = createState();
    const cfg = config();
    const model = {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      api: "openai-codex-responses",
      input: ["text"],
      reasoning: true,
      compat: {},
    } as any;
    const toResponsesInput = (messages: any[]) => convertResponsesMessages(
      model,
      { systemPrompt: "", messages, tools: [] } as any,
      new Set(["openai-codex"]),
    );
    const user = textMessage("user", "inspect", 1);
    const responseOne = {
      role: "assistant",
      provider: model.provider,
      api: model.api,
      model: model.id,
      stopReason: "toolUse",
      usage: {},
      content: [
        {
          type: "thinking",
          thinking: "signed reasoning",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_1",
            summary: [],
            encrypted_content: "encrypted-reasoning",
          }),
        },
        { type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.ts" } },
      ],
      timestamp: 2,
    };
    const resultOne = toolResult("call_1|fc_1", "read", "result one", 3);

    const requestOne = toResponsesInput(applyPruning([user], state, cfg));
    const requestTwo = toResponsesInput(applyPruning([user, responseOne, resultOne], state, cfg));

    expect(requestTwo.slice(0, requestOne.length)).toEqual(requestOne);
    expect(requestTwo[requestOne.length]).toEqual(JSON.parse(responseOne.content[0].thinkingSignature!));

    const responseTwo = {
      ...responseOne,
      content: [{
        type: "text",
        text: "done",
        textSignature: JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" }),
      }],
      stopReason: "stop",
      timestamp: 4,
    };
    const requestThree = toResponsesInput(
      applyPruning([user, responseOne, resultOne, responseTwo], state, cfg),
    );

    expect(requestThree.slice(0, requestTwo.length)).toEqual(requestTwo);
    expect(requestThree[requestThree.length - 1]).toMatchObject({
      type: "message",
      role: "assistant",
      id: "msg_2",
      phase: "final_answer",
    });
  });

  test("reapplying DCP to transformed context does not duplicate carriers", () => {
    const state = createState();
    const raw = [
      textMessage("user", "inspect", 1),
      assistantToolCall("c1", 2),
      toolResult("c1", "read", "result", 3),
    ];

    const once = applyPruning(raw, state, config());
    const twice = applyPruning(once, state, config());

    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(JSON.stringify(twice).match(/<dcp-message-ids>/g)).toHaveLength(2);
  });

  test("assistant metadata sanitizer is an identity fast path for signed content", () => {
    const assistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "unchanged", thinkingSignature: "signed" },
        { type: "text", text: "answer", textSignature: "text-signed" },
      ],
      timestamp: 10,
    };

    const sanitized = stripStaleDcpMetadataFromAssistantMessage(assistant);
    expect(sanitized).toBe(assistant);
    expect(sanitized.content[0]).toBe(assistant.content[0]);
    expect(sanitized.content[1]).toBe(assistant.content[1]);

    const transformed = applyPruning([assistant], createState(), config());
    expect(JSON.stringify(transformed[0])).toBe(JSON.stringify(assistant));
  });

  test("DCP context transform stays quiet below routine context pressure and clears stale anchors", async () => {
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const nudgeEvents: any[] = [];
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry(type: string, data: any) {
        if (type === "dcp-nudge") nudgeEvents.push(data);
      },
      sendMessage() {},
    } as any;

    await dcpModule(pi);
    const contextHandler = handlers.get("context")?.[0];
    expect(contextHandler).toBeDefined();

    const messages = [
      textMessage("user", "older completed research " + "a".repeat(2000), 1),
      textMessage("assistant", "older result " + "b".repeat(2000), 2),
      textMessage("user", "current request", 3),
    ];
    const ctx = (percent: number) => ({
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      getContextUsage: () => ({ tokens: percent * 100, contextWindow: 10_000, percent }),
    });

    const highResult = await contextHandler?.({ type: "context", messages }, ctx(70)) as { messages: any[] } | undefined;
    const highRendered = highResult?.messages.map(contentText).join("\n") ?? "";
    expect(highRendered).toContain("<dcp-system-reminder>");
    expect(nudgeEvents.map((event) => event.event)).toEqual(["emitted"]);

    const lowResult = await contextHandler?.({ type: "context", messages }, ctx(5)) as { messages: any[] } | undefined;
    const lowRendered = lowResult?.messages.map(contentText).join("\n") ?? "";
    expect(lowRendered).toContain("current request");
    expect(lowRendered).not.toContain("<dcp-system-reminder>");
    expect(lowRendered).not.toContain("CONCRETE NEXT ACTION");

    await contextHandler?.({ type: "context", messages }, ctx(70));
    expect(nudgeEvents.map((event) => event.event)).toEqual(["emitted", "emitted"]);
  });

  test("DCP fresh projection overrides stale-low native usage and aborts an unshrinkable huge paste", async () => {
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const nudgeEvents: any[] = [];
    let aborts = 0;
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry(type: string, data: any) {
        if (type === "dcp-nudge") nudgeEvents.push(data);
      },
      sendMessage() {},
    } as any;
    await dcpModule(pi);
    const contextHandler = handlers.get("context")?.[0];
    expect(contextHandler).toBeDefined();

    const messages = [textMessage("user", "fresh huge paste " + "x".repeat(50_000), 1)];
    const staleLowCtx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      getContextUsage: () => ({ tokens: 1_000, contextWindow: 10_000, percent: 10 }),
      abort() { aborts++; },
    };

    const result = await contextHandler?.(
      { type: "context", messages },
      staleLowCtx,
    ) as { messages: any[] } | undefined;
    const rendered = result?.messages.map(contentText).join("\n") ?? "";

    expect(rendered).toContain("fresh huge paste");
    expect(rendered).not.toContain("<dcp-system-reminder>");
    expect(nudgeEvents).toHaveLength(0);
    expect(aborts).toBe(1);
  });

  test("DCP does not spam routine reminders when no candidate exists below emergency pressure", async () => {
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const nudgeEvents: any[] = [];
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry(type: string, data: any) {
        if (type === "dcp-nudge") nudgeEvents.push(data);
      },
      sendMessage() {},
    } as any;
    await dcpModule(pi);
    const contextHandler = handlers.get("context")?.[0];
    const messages = [textMessage("user", "current short request", 1), textMessage("assistant", "short answer", 2)];
    const ctx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      getContextUsage: () => ({ tokens: 5_000, contextWindow: 10_000, percent: 50 }),
    };

    for (let pass = 0; pass < 4; pass++) {
      const result = await contextHandler?.({ type: "context", messages }, ctx) as { messages: any[] } | undefined;
      expect(result?.messages.map(contentText).join("\n") ?? "").not.toContain("<dcp-system-reminder>");
    }
    expect(nudgeEvents).toHaveLength(0);
  });

  test("DCP emits an emergency reminder when one active turn has no normal compression candidate", async () => {
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const nudgeEvents: any[] = [];
    let compressTool: any;
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerTool(tool: any) {
        if (tool.name === "compress") compressTool = tool;
      },
      registerCommand() {},
      appendEntry(type: string, data: any) {
        if (type === "dcp-nudge") nudgeEvents.push(data);
      },
      sendMessage() {},
    } as any;

    await dcpModule(pi);
    const contextHandler = handlers.get("context")?.[0];
    const providerHandler = handlers.get("before_provider_request")?.[0];
    const afterProviderHandler = handlers.get("after_provider_response")?.[0];
    const messageEndHandler = handlers.get("message_end")?.[0];
    const toolCallHandler = handlers.get("tool_call")?.[0];
    const toolResultHandler = handlers.get("tool_result")?.[0];
    expect(contextHandler).toBeDefined();
    expect(compressTool).toBeDefined();

    const seedMessages = [
      textMessage("user", "older completed research " + "a".repeat(2000), 1),
      textMessage("assistant", "older result " + "b".repeat(2000), 2),
      textMessage("user", "current request", 3),
    ];
    const lowPressureCtx = {
      hasUI: false,
      model: { provider: "test-provider", id: "test-model" },
      sessionManager: { getBranch: () => [] },
      getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
      ui: { notify() {} },
      abort() {},
    };
    const highPressureCtx = {
      ...lowPressureCtx,
      getContextUsage: () => ({ tokens: 9_000, contextWindow: 10_000, percent: 90 }),
    };

    // Seed addressable IDs, then cover every message before the latest user
    // turn with an active block. This mirrors the production overflow: the
    // normal detectors can only see b1 before the protected current turn.
    await contextHandler?.({ type: "context", messages: seedMessages }, lowPressureCtx);
    await compressTool.execute(
      "compress-seed",
      {
        topic: "Older completed work",
        ranges: [{ startId: "m001", endId: "m002", summary: "Completed work summary." }],
      },
      undefined,
      undefined,
      lowPressureCtx,
    );

    const messages = [...seedMessages];
    for (let i = 0; i < 12; i++) {
      const toolCallId = `current-turn-${i}`;
      const timestamp = 10 + i * 2;
      const output = `large read output ${i} ` + "x".repeat(4_000);
      messages.push(assistantToolCall(toolCallId, timestamp));
      messages.push(toolResult(toolCallId, "read", output, timestamp + 1));
      await toolCallHandler?.({
        type: "tool_call",
        toolCallId,
        toolName: "read",
        input: { path: `/tmp/file-${i}.txt` },
      }, lowPressureCtx);
      await toolResultHandler?.({
        type: "tool_result",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text: output }],
        details: {},
        isError: false,
      }, lowPressureCtx);
    }

    // Confirm this really is the no-normal-candidate shape independently of
    // the module's private state. The active block covers all older history;
    // all large outputs belong to the latest protected user turn.
    const candidateState = createState();
    candidateState.compressionBlocks = [{
      ...block(1, 1, 2),
      anchorTimestamp: 3,
    }];
    const normalCandidateConfig = config({
      compress: {
        autoCandidates: { keepRecentTurns: 1 },
        messageMode: { keepRecentTurns: 1 },
      } as any,
    });
    const candidateMessages = applyPruning(messages, candidateState, normalCandidateConfig);
    expect(detectCompressionCandidate(candidateMessages, candidateState, normalCandidateConfig, 0.9)).toBe(null);
    expect(detectMessageCompressionCandidates(candidateMessages, candidateState, normalCandidateConfig, 0.9)).toEqual([]);

    // Publish the completed same-turn results through the real provider lifecycle.
    // A later assistant alone is not evidence after F09.
    await contextHandler?.({ type: "context", messages }, lowPressureCtx);
    await providerHandler?.({
      type: "before_provider_request",
      payload: {
        messages: messages
          .filter((message) => message.role === "toolResult")
          .map((message) => ({ role: "tool", tool_call_id: message.toolCallId, content: contentText(message) })),
      },
    }, lowPressureCtx);
    await afterProviderHandler?.({ type: "after_provider_response", status: 200, headers: {} }, lowPressureCtx);
    await messageEndHandler?.({
      type: "message_end",
      message: {
        role: "assistant", provider: "test-provider", model: "test-model",
        content: [{ type: "text", text: "completed provider pass" }], stopReason: "stop", timestamp: 100,
      },
    }, lowPressureCtx);

    const result = await contextHandler?.({ type: "context", messages }, highPressureCtx) as { messages: any[] } | undefined;
    const rendered = result?.messages.map(contentText).join("\n") ?? "";

    expect(rendered).toContain("<dcp-system-reminder>");
    expect(rendered).toContain("CONCRETE NEXT ACTION");
    expect(nudgeEvents).toHaveLength(1);
    expect(nudgeEvents[0]?.type).toMatch(/^context-(strong|soft)$/);
  });

  test.serial("DCP hard fallback lowers one-turn provider context and emits distinct diagnostics", async () => {
    const debugDir = mkdtempSync(join(tmpdir(), "dcp-current-turn-debug-"));
    const debugPath = join(debugDir, "dcp-debug.jsonl");
    const previousDebug = process.env.PI_DCP_DEBUG;
    const previousDebugLog = process.env.PI_DCP_DEBUG_LOG;
    process.env.PI_DCP_DEBUG = "1";
    process.env.PI_DCP_DEBUG_LOG = debugPath;

    try {
      const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
      let compressTool: any;
      const pi = {
        on(event: string, handler: (event: any, ctx: any) => unknown) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        registerTool(tool: any) {
          if (tool.name === "compress") compressTool = tool;
        },
        registerCommand() {},
        appendEntry() {},
        sendMessage() {},
      } as any;
      await dcpModule(pi);
      const contextHandler = handlers.get("context")?.[0];
      const providerHandler = handlers.get("before_provider_request")?.[0];
      const afterProviderHandler = handlers.get("after_provider_response")?.[0];
      const messageEndHandler = handlers.get("message_end")?.[0];
      const toolCallHandler = handlers.get("tool_call")?.[0];
      const toolResultHandler = handlers.get("tool_result")?.[0];
      const lowPressureCtx = {
        hasUI: false,
        model: { provider: "test-provider", id: "test-model" },
        sessionManager: { getBranch: () => [] },
        getContextUsage: () => ({ tokens: 1_000, contextWindow: 10_000, percent: 10 }),
        ui: { notify() {} },
      };
      const highPressureCtx = {
        ...lowPressureCtx,
        getContextUsage: () => ({ tokens: 9_000, contextWindow: 10_000, percent: 90 }),
      };
      const seedMessages = [
        textMessage("user", "completed old request " + "a".repeat(2_000), 1),
        textMessage("assistant", "completed old result " + "b".repeat(2_000), 2),
        textMessage("user", "active implementation request", 3),
      ];
      await contextHandler?.({ type: "context", messages: seedMessages }, lowPressureCtx);
      await compressTool.execute(
        "seed-compress",
        { topic: "Completed history", ranges: [{ startId: "m001", endId: "m002", summary: "Old work done." }] },
        undefined,
        undefined,
        lowPressureCtx,
      );

      const messages = [...seedMessages];
      const addPair = async (index: number) => {
        const id = `long-turn-${index}`;
        const timestamp = 10 + index * 2;
        const output = `raw-${id}-` + "x".repeat(4_000);
        messages.push(assistantToolCall(id, timestamp));
        messages.push(toolResult(id, "read", output, timestamp + 1));
        await toolCallHandler?.({ type: "tool_call", toolCallId: id, toolName: "read", input: { path: `/tmp/${id}` } }, lowPressureCtx);
        await toolResultHandler?.({
          type: "tool_result",
          toolCallId: id,
          toolName: "read",
          content: [{ type: "text", text: output }],
          details: {},
          isError: false,
        }, lowPressureCtx);
      };
      for (let index = 0; index < 12; index++) await addPair(index);

      // A prior provider pass makes these results eligible. The final pair is
      // deliberately added afterwards and must remain fresh/unpruned.
      await contextHandler?.({ type: "context", messages }, lowPressureCtx);
      await providerHandler?.(
        {
          type: "before_provider_request",
          payload: {
            messages: messages
              .filter((message) => message.role === "toolResult")
              .map((message) => ({
                role: "tool",
                tool_call_id: message.toolCallId,
                content: contentText(message),
              })),
          },
        },
        lowPressureCtx,
      );
      await afterProviderHandler?.(
        { type: "after_provider_response", status: 200, headers: {} },
        lowPressureCtx,
      );
      await messageEndHandler?.({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "test-provider",
          model: "test-model",
          content: [{ type: "text", text: "provider pass complete" }],
          stopReason: "stop",
          timestamp: 100,
        },
      }, lowPressureCtx);
      await addPair(12);

      const beforeTokens = messages.reduce((sum, message) => sum + estimateTokens(contentText(message)), 0);
      const result = await contextHandler?.(
        { type: "context", messages },
        highPressureCtx,
      ) as { messages: any[] } | undefined;
      const outputMessages = result?.messages ?? [];
      const afterTokens = outputMessages.reduce((sum, message) => sum + estimateTokens(contentText(message)), 0);
      const rendered = outputMessages.map(contentText).join("\n");

      expect(afterTokens).toBeLessThan(beforeTokens);
      expect(rendered).toContain("current-turn context emergency");
      expect(rendered).toContain("raw-long-turn-12");
      expect(rendered).toContain("<dcp-system-reminder>");

      await dcpDebugLogDrain();
      const debugEntries = readFileSync(debugPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const events = debugEntries.map((entry) => entry.event);
      expect(events).toContain("context.emergency_compression_candidate");
      expect(events).toContain("context.strong_nudge_without_candidate");
      expect(events).toContain("context.progress_blocked");
      expect(events).not.toContain("compress.auto_blocked_no_candidate");
      expect(events).toContain("prune.emergency_current_turn");
      const blockedIndex = events.indexOf("context.progress_blocked");
      const seenIndex = events.indexOf("provider_payload.tool_results_seen");
      const candidateIndex = events.lastIndexOf("context.emergency_compression_candidate");
      expect(blockedIndex).toBeGreaterThanOrEqual(0);
      expect(seenIndex).toBeGreaterThan(blockedIndex);
      expect(candidateIndex).toBeGreaterThan(seenIndex);
      const pruneEvent = debugEntries.find((entry) => entry.event === "prune.emergency_current_turn");
      expect(pruneEvent.targetMet || pruneEvent.eligibleExhausted).toBe(true);
      expect(pruneEvent.prunedOutputs).toBeLessThan(pruneEvent.totalPairs);
      expect(pruneEvent.preservedRecentPairs).toBe(8);
    } finally {
      await dcpDebugLogDrain();
      if (previousDebug === undefined) delete process.env.PI_DCP_DEBUG;
      else process.env.PI_DCP_DEBUG = previousDebug;
      if (previousDebugLog === undefined) delete process.env.PI_DCP_DEBUG_LOG;
      else process.env.PI_DCP_DEBUG_LOG = previousDebugLog;
    }
  });

  test.serial("DCP emergency patience advances only on completed provider opportunities and persists across sidecar restore", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "dcp-emergency-opportunity-"));
    const sessionId = "emergency-opportunity";
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

    const runtimeConfig = loadConfig();
    const thresholds = resolveContextThresholds(
      runtimeConfig,
      ["test-provider/test-model", "test-model"],
      10_000,
    );
    const hardContextPercent = runtimeConfig.strategies.emergencyCurrentTurnPruning.hardContextPercent;
    let usagePercent = 100 * Math.max(
      0.90,
      thresholds.maxContextPercent + 0.05,
      hardContextPercent + 0.01,
    );
    const ctx = {
      hasUI: false,
      model: { provider: "test-provider", id: "test-model" },
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => sessionId,
        getSessionDir: () => sessionDir,
        getHeader: () => ({ id: sessionId, cwd: "/tmp" }),
      },
      getContextUsage: () => ({
        tokens: Math.round(usagePercent * 100),
        contextWindow: 10_000,
        percent: usagePercent,
      }),
    };
    await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

    const messages = [textMessage("user", "active request", 1), textMessage("assistant", "working", 2)];
    const statePath = join(sessionDir, "dcp-state", `${sessionId}.json`);

    // Repeated projection/context passes do not consume patience.
    await handlers.get("context")?.[0]?.({ type: "context", messages }, ctx);
    await handlers.get("context")?.[0]?.({ type: "context", messages }, ctx);
    expect(readPersistedDcpPayloadSync(statePath).consecutiveIgnoredStrongNudges).toBe(0);

    const providerEvent = {
      type: "before_provider_request",
      payload: { messages: [{ role: "user", content: "active request" }] },
    };

    // One completed provider response with the emergency reminder available
    // consumes exactly one opportunity. HTTP acceptance alone consumes none.
    await handlers.get("before_provider_request")?.[0]?.(providerEvent, ctx);
    await handlers.get("after_provider_response")?.[0]?.(
      { type: "after_provider_response", status: 200, headers: {} },
      ctx,
    );
    expect(readPersistedDcpPayloadSync(statePath).consecutiveIgnoredStrongNudges).toBe(0);
    await handlers.get("message_end")?.[0]?.({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "test-provider",
        model: "test-model",
        content: [{ type: "text", text: "still working" }],
        stopReason: "stop",
        timestamp: 3,
      },
    }, ctx);
    expect(readPersistedDcpPayloadSync(statePath).consecutiveIgnoredStrongNudges).toBe(1);

    // A transport/provider retry of the identical logical request is still one
    // model opportunity, not two patience ticks.
    await handlers.get("context")?.[0]?.({ type: "context", messages }, ctx);
    await handlers.get("before_provider_request")?.[0]?.(providerEvent, ctx);
    await handlers.get("before_provider_request")?.[0]?.(providerEvent, ctx);
    await handlers.get("message_end")?.[0]?.({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "test-provider",
        model: "test-model",
        content: [{ type: "text", text: "still working after retry" }],
        stopReason: "stop",
        timestamp: 4,
      },
    }, ctx);
    const serialized = readPersistedDcpPayloadSync(statePath);
    expect(serialized.consecutiveIgnoredStrongNudges).toBe(2);

    const restored = createState();
    restoreState(restored, serialized);
    expect(restored.consecutiveIgnoredStrongNudges).toBe(2);

    usagePercent = Math.max(1, Math.max(0, thresholds.minContextPercent - 0.05) * 100);
    await handlers.get("context")?.[0]?.({ type: "context", messages }, ctx);
    const afterRelief = readPersistedDcpPayloadSync(statePath);
    expect(afterRelief.consecutiveIgnoredStrongNudges).toBe(0);
  });

  test.serial("DCP marks provider exposure only after a successful response", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "dcp-provider-exposure-"));
    const sessionId = "provider-exposure";
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
    const ctx = {
      hasUI: false,
      model: { provider: "test-provider", id: "test-model" },
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => sessionId,
        getSessionDir: () => sessionDir,
      },
      getContextUsage: () => ({ tokens: 1_000, contextWindow: 10_000, percent: 10 }),
    };
    const output = "provider output";
    const messages = [
      textMessage("user", "active request", 1),
      assistantToolCall("provider-pair", 2),
      toolResult("provider-pair", "read", output, 3),
    ];
    await handlers.get("tool_call")?.[0]?.(
      { type: "tool_call", toolCallId: "provider-pair", toolName: "read", input: { path: "/tmp/a" } },
      ctx,
    );
    await handlers.get("tool_result")?.[0]?.({
      type: "tool_result",
      toolCallId: "provider-pair",
      toolName: "read",
      content: [{ type: "text", text: output }],
      details: {},
      isError: false,
    }, ctx);
    await handlers.get("context")?.[0]?.({ type: "context", messages }, ctx);

    const providerEvent = {
      type: "before_provider_request",
      payload: { messages: [{ role: "tool", tool_call_id: "provider-pair", content: output }] },
    };
    await handlers.get("before_provider_request")?.[0]?.(providerEvent, ctx);
    await handlers.get("after_provider_response")?.[0]?.(
      { type: "after_provider_response", status: 500, headers: {} },
      ctx,
    );
    await handlers.get("agent_end")?.[0]?.({ type: "agent_end" }, ctx);
    const statePath = join(sessionDir, "dcp-state", `${sessionId}.json`);
    expect(readPersistedDcpPayloadSync(statePath).providerSeenToolIds).toEqual([]);

    await handlers.get("before_provider_request")?.[0]?.(providerEvent, ctx);
    await handlers.get("after_provider_response")?.[0]?.(
      { type: "after_provider_response", status: 200, headers: {} },
      ctx,
    );
    expect(readPersistedDcpPayloadSync(statePath).providerSeenToolIds).toEqual([]);

    // Non-assistant message_end events are unrelated to provider completion and
    // must not consume the pending request evidence.
    await handlers.get("message_end")?.[0]?.({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "follow-up" }], timestamp: 4 },
    }, ctx);
    expect(readPersistedDcpPayloadSync(statePath).providerSeenToolIds).toEqual([]);

    await handlers.get("message_end")?.[0]?.({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "test-provider",
        model: "test-model",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        timestamp: 4,
      },
    }, ctx);
    expect(readPersistedDcpPayloadSync(statePath).providerSeenToolIds).toEqual(["provider-pair"]);
  });

  test("DCP context transform forces a strong nudge on context-window downgrade", async () => {
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const nudgeEvents: any[] = [];
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry(type: string, data: any) {
        if (type === "dcp-nudge") nudgeEvents.push(data);
      },
      sendMessage() {},
    } as any;

    await dcpModule(pi);
    const contextHandler = handlers.get("context")?.[0];
    expect(contextHandler).toBeDefined();

    const messages = [
      textMessage("user", "older completed research " + "a".repeat(2000), 1),
      textMessage("assistant", "older result " + "b".repeat(2000), 2),
      textMessage("user", "current request", 3),
    ];

    // Derive pressure from the resolved config thresholds so the test is
    // independent of the ambient user config at ~/.config/pi/pi-tools-suite.jsonc
    // (its min/max can differ from the in-repo defaults, e.g. 20%/55% vs 40%/65%).
    const resolvedThresholds = resolveContextThresholds(loadConfig(), []);
    const pass1Fraction = Math.max(0.01, resolvedThresholds.minContextPercent - 0.05);
    const pass2Fraction = (resolvedThresholds.minContextPercent + resolvedThresholds.maxContextPercent) / 2;
    const largeWindow = 1_000_000;
    const downgradedWindow = 275_000;

    // Pass 1: large window, pressure just below minContextPercent so no nudge
    // fires — but the window is recorded for the downgrade comparison.
    const largeWindowCtx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      getContextUsage: () => ({
        tokens: Math.round(largeWindow * pass1Fraction),
        contextWindow: largeWindow,
        percent: pass1Fraction * 100,
      }),
    };
    const pass1 = await contextHandler?.({ type: "context", messages }, largeWindowCtx) as { messages: any[] } | undefined;
    const pass1Rendered = pass1?.messages.map(contentText).join("\n") ?? "";
    expect(pass1Rendered).not.toContain("<dcp-system-reminder>");
    expect(nudgeEvents).toHaveLength(0);

    // Pass 2: window shrinks to 275K (below 90% of the 1M pass-1 window). The
    // same inherited tokens now sit above minContextPercent but below
    // maxContextPercent, a zone where the normal cadence might only emit a
    // turn/iteration nudge. The downgrade must force a context-strong nudge.
    const downgradedCtx = {
      hasUI: false,
      sessionManager: { getBranch: () => [] },
      getContextUsage: () => ({
        tokens: Math.round(downgradedWindow * pass2Fraction),
        contextWindow: downgradedWindow,
        percent: pass2Fraction * 100,
      }),
    };
    const pass2 = await contextHandler?.({ type: "context", messages }, downgradedCtx) as { messages: any[] } | undefined;
    const pass2Rendered = pass2?.messages.map(contentText).join("\n") ?? "";
    expect(pass2Rendered).toContain("<dcp-system-reminder>");
    // A downgrade-forced strong nudge is recorded as context-strong telemetry.
    expect(nudgeEvents.map((event) => event.type)).toContain("context-strong");
  });

  test("DCP auto-compress decision fires after patience ignored strong nudges above emergency threshold", () => {
    const cfg = config({
      compress: {
        minContextPercent: 0.40,
        maxContextPercent: 0.65,
        autoCompress: { enabled: true, patience: 2, summarizerModel: [], timeoutMs: 1000 },
      } as any,
    });
    const state = createState();
    const candidate: CompressionCandidate = {
      startId: "m001",
      endId: "m003",
      messageCount: 3,
      estimatedTokens: 1000,
      includedBlockIds: [],
      reason: "test",
    };

    // Below patience: 2 ignored strongs, patience=2 → not yet (needs >patience).
    state.consecutiveIgnoredStrongNudges = 2;
    expect(decideAutoCompress(state, cfg, 0.80, 0.65, candidate).shouldFire).toBe(false);

    // At patience+1 ignored strongs, above max, with a candidate → fires.
    state.consecutiveIgnoredStrongNudges = 3;
    expect(decideAutoCompress(state, cfg, 0.80, 0.65, candidate).shouldFire).toBe(true);

    // Above patience but below emergency threshold → must not fire.
    state.consecutiveIgnoredStrongNudges = 5;
    expect(decideAutoCompress(state, cfg, 0.50, 0.65, candidate).shouldFire).toBe(false);

    // No candidate → must not fire even above threshold + patience.
    state.consecutiveIgnoredStrongNudges = 5;
    expect(decideAutoCompress(state, cfg, 0.80, 0.65, null).shouldFire).toBe(false);
  });

  test("DCP manual mode cannot be widened into autonomous summary creation", () => {
    const state = createState();
    state.manualMode = true;
    state.consecutiveIgnoredStrongNudges = 99;
    const cfg = config({
      compress: { autoCompress: { enabled: true, patience: 0, summarizerModel: [], timeoutMs: 1000 } } as any,
    });
    const candidate: CompressionCandidate = {
      startId: "m001", endId: "m002", messageCount: 2, estimatedTokens: 5000, includedBlockIds: [], reason: "test",
    };

    expect(decideAutoCompress(state, cfg, 0.9, 0.65, candidate)).toEqual({
      shouldFire: false,
      reason: "auto-disabled",
    });
  });

  test("DCP auto-compress decision is disabled when autoCompress.enabled=false", () => {
    const cfg = config(); // autoCompress.enabled defaults to false
    const state = createState();
    state.consecutiveIgnoredStrongNudges = 10;
    const candidate: CompressionCandidate = {
      startId: "m001",
      endId: "m003",
      messageCount: 3,
      estimatedTokens: 1000,
      includedBlockIds: [],
      reason: "test",
    };
    expect(decideAutoCompress(state, cfg, 0.90, 0.65, candidate).shouldFire).toBe(false);
  });

  test("DCP auto-compress creates a programmatic block when summarizerModel is empty", async () => {
    const cfg = config({
      compress: {
        minContextPercent: 0.40,
        maxContextPercent: 0.65,
        autoCompress: { enabled: true, patience: 2, summarizerModel: [], timeoutMs: 1000 },
      } as any,
    });
    const state = createState();
    const messages = [
      textMessage("user", "older research " + "a".repeat(2000), 1000),
      textMessage("assistant", "older result " + "b".repeat(2000), 2000),
      textMessage("user", "current request", 3000),
    ];
    // Seed the message-id snapshot so the candidate's start/end resolve.
    state.messageIdSnapshot.set("m001", 1000);
    state.messageIdSnapshot.set("m002", 2000);
    state.messageMetaSnapshot.set("m001", {
      timestamp: 1000,
      stableId: "id:start",
      role: "user",
      blockId: undefined,
      text: "",
      tokenEstimate: 100,
      priority: "medium",
    });
    state.messageMetaSnapshot.set("m002", {
      timestamp: 2000,
      stableId: "id:end",
      role: "assistant",
      blockId: undefined,
      text: "",
      tokenEstimate: 100,
      priority: "medium",
    });

    const candidate: CompressionCandidate = {
      startId: "m001",
      endId: "m002",
      messageCount: 2,
      estimatedTokens: 1000,
      includedBlockIds: [],
      reason: "test",
    };

    const result = await createAutoCompressionBlock({
      candidate,
      topic: "Earlier work",
      state,
      config: cfg,
      messages,
    });

    expect(result.summaryMode).toBe("programmatic");
    expect(result.blockId).toBeGreaterThan(0);
    expect(state.compressionBlocks.length).toBe(1);
    expect(state.compressionBlocks[0]?.active).toBe(true);
    expect(state.compressionBlocks[0]?.summary).toContain("Earlier work");
    expect(state.compressionBlocks[0]?.summary).toContain("Auto-compressed by DCP");
  });

  test("DCP auto-compress rejects a non-positive gain without mutating state", async () => {
    const cfg = config({
      compress: {
        autoCompress: { enabled: true, patience: 2, summarizerModel: [], timeoutMs: 1000 },
      } as any,
    });
    const state = createState();
    const messages = [textMessage("assistant", "tiny source", 10)];
    const stableId = stableMessageKeys(messages)[0]!;
    state.messageIdsByStableId.set(stableId, "m001");
    state.messageIdSnapshot.set("m001", 10);
    state.messageMetaSnapshot.set("m001", {
      timestamp: 10,
      stableId,
      role: "assistant",
      tokenEstimate: 3,
    });

    await expect(createAutoCompressionBlock({
      candidate: {
        startId: "m001",
        endId: "m001",
        messageCount: 1,
        estimatedTokens: 3,
        includedBlockIds: [],
        reason: "non-positive gain regression",
      },
      topic: "Tiny source",
      state,
      config: cfg,
      messages,
    })).rejects.toThrow(/non-positive|positive gain/i);

    expect(state.compressionBlocks).toHaveLength(0);
    expect(state.nextBlockId).toBe(1);
  });

  test("DCP auto-compress rejects positive gain below required budget recovery atomically", async () => {
    const cfg = config({
      compress: {
        autoCompress: { enabled: true, patience: 2, summarizerModel: [], timeoutMs: 1000 },
      } as any,
    });
    const state = createState();
    const messages = [
      textMessage("assistant", "a".repeat(4_000), 10),
      textMessage("assistant", "b".repeat(4_000), 11),
    ];
    const stableKeys = stableMessageKeys(messages);
    for (const [visibleId, index] of [["m001", 0], ["m002", 1]] as const) {
      state.messageIdsByStableId.set(stableKeys[index]!, visibleId);
      state.messageIdSnapshot.set(visibleId, messages[index]!.timestamp);
      state.messageMetaSnapshot.set(visibleId, {
        timestamp: messages[index]!.timestamp,
        stableId: stableKeys[index]!,
        role: "assistant",
        tokenEstimate: estimateTokens(contentText(messages[index])),
      });
    }

    let blocked: unknown;
    try {
      await createAutoCompressionBlock({
        candidate: {
          startId: "m001",
          endId: "m002",
          messageCount: 2,
          estimatedTokens: messages.reduce((sum, message) => sum + estimateTokens(contentText(message)), 0),
          includedBlockIds: [],
          reason: "budget recovery regression",
        },
        topic: "Budget recovery",
        state,
        config: cfg,
        messages,
        requiredGainTokens: 100_000,
      });
    } catch (error) {
      blocked = error;
    }
    expect(blocked).toBeInstanceOf(AutoCompressionBlockedError);
    expect((blocked as AutoCompressionBlockedError).blockedReason).toBe("budget-exhausted");
    expect((blocked as Error).message).toMatch(/required budget recovery|below required/i);

    expect(state.compressionBlocks).toHaveLength(0);
    expect(state.nextBlockId).toBe(1);
  });

  test("DCP auto-compress does not publish live state when durable publication fails", async () => {
    const cfg = config({
      compress: {
        autoCompress: { enabled: true, patience: 2, summarizerModel: [], timeoutMs: 1000 },
      } as any,
    });
    const state = createState();
    const messages = [
      { id: "persist-start", role: "assistant", content: [{ type: "text", text: "a".repeat(2400) }], timestamp: 10 },
      { id: "persist-end", role: "assistant", content: [{ type: "text", text: "b".repeat(2400) }], timestamp: 11 },
    ];
    const stableKeys = stableMessageKeys(messages);
    for (const [visibleId, index] of [["m001", 0], ["m002", 1]] as const) {
      const message = messages[index];
      state.messageIdsByStableId.set(stableKeys[index]!, visibleId);
      state.messageIdSnapshot.set(visibleId, message.timestamp);
      state.messageMetaSnapshot.set(visibleId, {
        timestamp: message.timestamp,
        stableId: stableKeys[index],
        role: message.role,
        tokenEstimate: 600,
      });
    }
    let persistAttempts = 0;

    await expect(createAutoCompressionBlock({
      candidate: {
        startId: "m001",
        endId: "m002",
        messageCount: 2,
        estimatedTokens: 1200,
        includedBlockIds: [],
        reason: "durability failure",
      },
      topic: "Durable first",
      state,
      config: cfg,
      messages,
      persistState: async () => {
        persistAttempts++;
        throw new Error("simulated disk full");
      },
    })).rejects.toThrow(/simulated disk full/);

    expect(persistAttempts).toBe(1);
    expect(state.compressionBlocks).toHaveLength(0);
    expect(state.nextBlockId).toBe(1);
  });

  test("DCP auto-compress rejects a late summary after the session epoch changes", async () => {
    const cfg = config({
      compress: {
        autoCompress: { enabled: true, patience: 2, summarizerModel: [], timeoutMs: 1000 },
      } as any,
    });
    const state = createState();
    const messages = [
      { id: "late-start", role: "assistant", content: [{ type: "text", text: "a".repeat(2400) }], timestamp: 10 },
      { id: "late-end", role: "assistant", content: [{ type: "text", text: "b".repeat(2400) }], timestamp: 11 },
    ];
    const stableKeys = stableMessageKeys(messages);
    for (const [visibleId, index] of [["m001", 0], ["m002", 1]] as const) {
      const message = messages[index];
      state.messageIdsByStableId.set(stableKeys[index]!, visibleId);
      state.messageIdSnapshot.set(visibleId, message.timestamp);
      state.messageMetaSnapshot.set(visibleId, {
        timestamp: message.timestamp,
        stableId: stableKeys[index],
        role: message.role,
        tokenEstimate: 600,
      });
    }
    const startingEpoch = state.sessionEpoch;

    await expect(createAutoCompressionBlock({
      candidate: {
        startId: "m001",
        endId: "m002",
        messageCount: 2,
        estimatedTokens: 1200,
        includedBlockIds: [],
        reason: "late auto result",
      },
      topic: "Stale auto",
      state,
      config: cfg,
      messages,
      persistState: async () => {
        resetState(state);
      },
    })).rejects.toThrow(/stale|session changed/i);

    expect(state.sessionEpoch).toBe(startingEpoch + 1);
    expect(state.compressionBlocks).toHaveLength(0);
    expect(state.nextBlockId).toBe(1);
  });

  test("DCP auto-compress closes a partial parallel group before building its summary", async () => {
    const cfg = config({
      compress: {
        autoCompress: { enabled: true, patience: 2, summarizerModel: [], timeoutMs: 1000 },
      } as any,
    });
    const state = createState();
    const rawMessages = [
      textMessage("user", "older request", 1),
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "auto-a", name: "read", input: { path: "a.ts" } },
          { type: "toolCall", id: "auto-b", name: "read", input: { path: "b.ts" } },
        ],
        timestamp: 2,
      },
      toolResult("auto-a", "read", "AUTO_A " + "a".repeat(1200), 3),
      toolResult("auto-b", "read", "AUTO_B_UNIQUE " + "b".repeat(1200), 4),
      textMessage("user", "active request", 5),
    ];
    const projectedBefore = applyPruning(rawMessages, state, cfg);
    const resultAId = [...state.messageMetaSnapshot.entries()]
      .find(([, meta]) => meta.toolCallId === "auto-a")?.[0];
    const assistantStableId = [...state.messageMetaSnapshot.values()]
      .find((meta) => meta.role === "assistant" && meta.toolCallIds?.includes("auto-a"))?.stableId;
    const resultBStableId = [...state.messageMetaSnapshot.values()]
      .find((meta) => meta.toolCallId === "auto-b")?.stableId;
    expect(resultAId).toBeDefined();

    const result = await createAutoCompressionBlock({
      candidate: {
        startId: resultAId!,
        endId: resultAId!,
        messageCount: 1,
        estimatedTokens: 300,
        includedBlockIds: [],
        reason: "partial parallel group",
      },
      topic: "Closed auto group",
      state,
      config: cfg,
      messages: projectedBefore,
    });

    expect(result.summaryMode).toBe("programmatic");
    expect(state.compressionBlocks[0]).toMatchObject({
      version: 2,
      replacementMode: "range",
      startMessageId: assistantStableId,
      endMessageId: resultBStableId,
    });
    expect(state.compressionBlocks[0]?.summary).toContain("read×2");

    const projectedAfter = applyPruning(rawMessages, state, cfg);
    const asJson = JSON.stringify(projectedAfter);
    expect(asJson).toContain("Compressed section: Closed auto group");
    expect(asJson).not.toContain("AUTO_A");
    expect(asJson).not.toContain("AUTO_B_UNIQUE");
    expect(asJson).toContain("older request");
    expect(asJson).toContain("active request");
  });

  test("DCP auto-compress excludes a same-timestamp live head from its summary input", async () => {
    const cfg = config({
      compress: {
        autoCompress: { enabled: true, patience: 2, summarizerModel: [], timeoutMs: 1000 },
      } as any,
    });
    const state = createState();
    const messages = [
      { id: "171", role: "assistant", content: [{ type: "toolCall", id: "a", name: "range_start", input: { payload: "a".repeat(1600) } }], timestamp: 10 },
      { id: "172", role: "assistant", content: [{ type: "toolCall", id: "b", name: "range_end", input: { payload: "b".repeat(1600) } }], timestamp: 11 },
      { id: "173", role: "assistant", content: [{ type: "toolCall", id: "c", name: "LIVE_HEAD_TOOL", input: { payload: "live" } }], timestamp: 11 },
    ];
    for (const [stableId, visibleId, timestamp] of [
      ["id:171", "m171", 10],
      ["id:172", "m172", 11],
      ["id:173", "m173", 11],
    ] as const) {
      state.messageIdsByStableId.set(stableId, visibleId);
      state.messageIdSnapshot.set(visibleId, timestamp);
      state.messageMetaSnapshot.set(visibleId, {
        timestamp,
        stableId,
        role: "assistant",
        tokenEstimate: 100,
      });
    }

    const result = await createAutoCompressionBlock({
      candidate: {
        startId: "m171",
        endId: "m172",
        messageCount: 2,
        estimatedTokens: 200,
        includedBlockIds: [],
        reason: "same timestamp boundary regression",
      },
      topic: "Stable boundary summary",
      state,
      config: cfg,
      messages,
    });

    expect(result.summaryMode).toBe("programmatic");
    expect(state.compressionBlocks[0]?.summary).toContain("range_start×1");
    expect(state.compressionBlocks[0]?.summary).toContain("range_end×1");
    expect(state.compressionBlocks[0]?.summary).not.toContain("LIVE_HEAD_TOOL");
    expect(state.compressionBlocks[0]?.anchorMessageId).toBe("id:173");
  });

  test("DCP context transform emits context-limit nudges with concrete candidates", async () => {
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
          textMessage("user", "old request " + "a".repeat(1500), 1),
          textMessage("assistant", "old analysis " + "b".repeat(1500), 2),
          textMessage("user", "old follow-up " + "c".repeat(1500), 3),
          textMessage("assistant", "old result " + "d".repeat(1500), 4),
          textMessage("user", "older verification " + "e".repeat(1500), 5),
          textMessage("assistant", "older verification result " + "f".repeat(1500), 6),
          textMessage("user", "current request", 7),
        ],
      },
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        getContextUsage: () => ({ tokens: 7_000, contextWindow: 10_000, percent: 70 }),
      },
    ) as { messages: any[] } | undefined;

    const messages = result?.messages ?? [];
    const rendered = messages.map(contentText).join("\n");
    const normalMessages = messages.filter((message) => message.role !== "custom");

    // Opener differs by nudgeForce ("soft"/"strong"); the candidate line is the force-independent signal.
    expect(rendered).toMatch(/ACTION REQUIRED: Context usage is high\.|CRITICAL WARNING: MAX CONTEXT LIMIT REACHED/);
    expect(rendered).toContain("Recommended range candidate: m001..m006");
    expect(JSON.stringify(normalMessages)).not.toContain("[dcp-id]");
    expect(JSON.stringify(messages)).toContain("Stable DCP IDs");
    expect(contentText(messages.find((message) => message.role === "assistant"))).not.toContain("<dcp-message-ids>");
  });

  test("DCP context transform strips leaked message-id control blocks from prior transcript", async () => {
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
          textMessage("user", "before\n<dcp-message-ids>\nsecret ids\n</dcp-message-ids>\nafter", 1),
          textMessage("assistant", "visible assistant", 2),
        ],
      },
      {
        hasUI: false,
        sessionManager: { getBranch: () => [] },
        getContextUsage: () => ({ tokens: 10, contextWindow: 10_000, percent: 0.1 }),
      },
    ) as { messages: any[] } | undefined;

    const rendered = result?.messages.map(contentText).join("\n") ?? "";
    expect(rendered).toContain("before");
    expect(rendered).toContain("after");
    expect(rendered).not.toContain("secret ids");
    expect(rendered.match(/<dcp-message-ids>/g)).toHaveLength(1);
    expect(rendered).toContain("Stable DCP IDs");
  });

  test("DCP context transform hides persisted control-plane custom entries from the model", async () => {
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
          textMessage("user", "keep visible user content", 1),
          {
            role: "custom",
            customType: "dcp-state",
            content: "DCP_STATE_PAYLOAD " + "x".repeat(50_000),
            timestamp: 2,
          },
          {
            role: "custom",
            customType: "dcp-nudge",
            content: "DCP_NUDGE_TELEMETRY",
            timestamp: 3,
          },
          {
            role: "custom",
            customType: "dcp-message-ids",
            content: "STALE_DCP_MESSAGE_IDS",
            timestamp: 4,
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
    expect(rendered).toContain("keep visible user content");
    expect(rendered).not.toContain("DCP_STATE_PAYLOAD");
    expect(rendered).not.toContain("DCP_NUDGE_TELEMETRY");
    expect(rendered).not.toContain("STALE_DCP_MESSAGE_IDS");
  });

  test("DCP module stays headless and only registers non-UI hooks", async () => {
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
    expect(events).not.toContain("turn_end");
    expect(events).toContain("message_end");
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
    state.progressRecovery = {
      blockedReason: "protected-budget-exceeded",
      projectedBeforeTokens: 12_000,
      inputCapacityTokens: 10_000,
      requiredSavingsTokens: 2_500,
      contextWindow: 16_000,
      createdAt: 789,
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
    expect(restored.progressRecovery).toEqual(state.progressRecovery);
  });
});
