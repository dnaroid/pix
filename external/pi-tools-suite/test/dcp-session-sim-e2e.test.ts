import { describe, expect, test } from "bun:test";
import { prepareDcpReminderScenario } from "./support/dcp-reminder-scenario.js";
import { closeConversationRange } from "../src/dcp/conversation-index.js";

import { DcpSessionSimulator } from "./support/dcp-session-simulator.js";
import { formatDcpStatistics } from "../src/dcp/statistics.js";

function configureEfficiencyScenario(config: any): void {
  config.debug = false;
  config.compress.minContextPercent = 0.10;
  config.compress.maxContextPercent = 0.55;
  config.compress.summaryBuffer = false;
  config.compress.nudgeFrequency = 1;
  config.compress.autoCandidates.enabled = true;
  config.compress.autoCandidates.minContextPercent = 0.10;
  config.compress.autoCandidates.keepRecentTurns = 1;
  config.compress.autoCandidates.minMessages = 2;
  config.compress.autoCandidates.minTokens = 100;
  config.compress.messageMode.enabled = true;
  config.compress.messageMode.minContextPercent = 0.10;
  config.compress.messageMode.keepRecentTurns = 1;
  config.compress.autoCompress = {
    enabled: true,
    patience: 0,
    summarizerModel: [],
    summarizerFallbackModels: [],
    timeoutMs: 5_000,
  };
  config.strategies.emergencyCurrentTurnPruning.enabled = true;
  config.strategies.emergencyCurrentTurnPruning.hardContextPercent = 0.82;
  config.strategies.emergencyCurrentTurnPruning.targetContextPercent = 0.65;
  config.strategies.emergencyCurrentTurnPruning.patience = 1;
  config.strategies.emergencyCurrentTurnPruning.keepRecentToolPairs = 4;
  config.strategies.emergencyCurrentTurnPruning.minOutputTokens = 100;
}

function toolOutput(index: number): string {
  const fact = index % 15 === 0 ? `Decision: SESSION_SIM_FACT_${index}_MUST_SURVIVE\n` : "";
  return `${fact}${`inspection-${index} repeated diagnostic line\n`.repeat(90)}`;
}

describe("DCP deterministic session-simulation E2E", () => {
  test("resumed history compresses both sides of an interrupted wait using the delivered recommendations without retries", async () => {
    const sim = await DcpSessionSimulator.create({
      contextWindow: 64_000,
      sessionId: "interrupted-wait-recovery",
      configure(config) {
        config.debug = false;
        for (const strategy of Object.values(config.strategies)) strategy.enabled = false;
        config.compress.minContextPercent = 0.26;
        config.compress.maxContextPercent = 0.80;
        config.compress.summaryBuffer = false;
        config.compress.nudgeFrequency = 1;
        config.compress.iterationNudgeThreshold = 1;
        Object.assign(config.compress.autoCandidates, {
          enabled: true, minContextPercent: 0.26, keepRecentTurns: 1, minMessages: 2, minTokens: 100,
        });
        // Only the simulated model may act: an auto fallback must not hide a bad hint.
        config.compress.autoCompress.enabled = false;
        config.compress.autoCompress.summarizerModel = [];
        config.compress.autoCompress.summarizerFallbackModels = [];
      },
    });
    try {
      sim.appendUser("Inspect the original issue. Preserve BEFORE_RESTART_FACT.");
      for (let index = 0; index < 3; index++) {
        await sim.toolTurn({ output: `Decision: BEFORE_RESTART_FACT.\n${"old inspection detail\n".repeat(100)}` });
      }
      const interruptedId = await sim.interruptedToolTurn({
        toolName: "subagents", input: { action: "wait", timeout: 300 }, label: "interrupted-wait",
      });
      await sim.restart();
      sim.appendUser("Continue after restart. Preserve AFTER_RESTART_FACT.");
      for (let index = 0; index < 3; index++) {
        await sim.toolTurn({ output: `Decision: AFTER_RESTART_FACT.\n${"resumed inspection detail\n".repeat(100)}` });
      }
      sim.appendUser("ACTIVE_REQUEST: now investigate cleanup; keep this turn intact.");
      await sim.toolTurn({
        output: `ACTIVE_TOOL_OUTPUT\n${"still needed cleanup diagnostics\n".repeat(3_000)}`,
        label: "large-active-result",
      });
      const initial = await sim.project("first-recommendation");
      expect(initial.sample.reminderCarriers).toEqual(["toolResult"]);
      expect(sim.state.compressionBlocks).toHaveLength(0);
      const findInterrupted = (messages: any[]) => messages.find((message) =>
        message.role === "assistant" && message.content.some((part: any) => part.type === "toolCall" && part.id === interruptedId),
      );
      const originalInterrupted = structuredClone(findInterrupted(initial.messages));
      expect(originalInterrupted).toBeDefined();
      const interruptedStableId = sim.state.conversationIndexSnapshot.find((entry) => entry.toolCallIds?.includes(interruptedId))!.stableId;
      const activeStart = initial.messages.findIndex((message) =>
        message.role === "user" && JSON.stringify(message.content).includes("ACTIVE_REQUEST"),
      );
      expect(activeStart).toBeGreaterThanOrEqual(0);
      const activeStableIds = new Set(sim.state.conversationIndexSnapshot.slice(activeStart).map((entry) => entry.stableId));
      const selectedStableIds: string[][] = [];
      for (const [index, fact] of ["BEFORE_RESTART_FACT", "AFTER_RESTART_FACT"].entries()) {
        const projection = await sim.project(`recommendation-${index}`);
        const reminder = sim.state.nudgeAnchors[0]?.renderedReminder ?? "";
        const match = /Recommended range candidate: (\w+)\.\.(\w+)/.exec(reminder);
        expect(match).not.toBeNull();
        const [, startId, endId] = match!;
        const closure = closeConversationRange(sim.state.conversationIndexSnapshot, startId!, endId!)!;
        expect(closure).toMatchObject({ expanded: false, incompleteToolGroup: false });
        selectedStableIds.push(sim.state.conversationIndexSnapshot.slice(closure.startIndex, closure.endIndex + 1).map((entry) => entry.stableId));
        const { sample, result } = await sim.compressTurn({
          topic: `Completed work ${index}`, ranges: [{ startId, endId, summary: `Decision: ${fact}. Inspection complete.` }],
        });
        expect(sample.providerSent).toBe(true);
        expect(sample.reminderCarriers).toEqual(["toolResult"]);
        expect(result.isError).not.toBe(true);
        expect(result.details).toMatchObject({ committed: true });
        expect(result.details.netGain).toBeGreaterThan(0);
        const after = await sim.project(`after-compress-${index}`);
        expect(after.sample.projectedTokens).toBeLessThan(projection.sample.projectedTokens);
      }
      expect(selectedStableIds.flat()).not.toContain(interruptedStableId);
      expect(selectedStableIds.flat().some((id) => activeStableIds.has(id))).toBe(false);
      expect(selectedStableIds[0]!.some((id) => selectedStableIds[1]!.includes(id))).toBe(false);
      const beforeRestart = await sim.project("before-final-restart");
      expect(findInterrupted(beforeRestart.messages)).toEqual(originalInterrupted);
      expect(beforeRestart.messages.some((message) => message.role === "toolResult" && message.toolCallId === interruptedId)).toBe(false);
      const text = JSON.stringify(beforeRestart.messages);
      for (const fact of ["BEFORE_RESTART_FACT", "AFTER_RESTART_FACT", "ACTIVE_REQUEST", "ACTIVE_TOOL_OUTPUT"]) {
        expect(text).toContain(fact);
      }
      await sim.restart();
      const replay = await sim.project("replayed-successful-compressions");
      expect(replay.messages).toEqual(beforeRestart.messages);
      expect(sim.report()).toMatchObject({ compressionCommits: 2, providerCapacityViolations: 0, aborts: 0 });
      expect(sim.report().toolReminderProviderTurns).toBeGreaterThanOrEqual(2);
    } finally { sim.dispose(); }
  });

  test("single-user session delivers a tool-result reminder and replays its exact bytes after restart", async () => {
    const { sim, previous, projected } = await prepareDcpReminderScenario();
    try {
      expect(sim.state.compressionBlocks).toHaveLength(0);
      expect(projected.sample.reminderCarriers).toEqual(["toolResult"]);
      expect(projected.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
      expect(sim.state.nudgeAnchors[0]?.renderedReminder).toContain("Recommended range candidate:");
      const delivered = await sim.assistantTurn("Continuing after the reminder.", "reminder-delivery");
      expect(delivered.reminderCarriers).toEqual(["toolResult"]);
      expect(sim.state.consecutiveIgnoredNudges).toBe(1);
      const beforeRestart = await sim.project("before-restart");
      const anchors = structuredClone(sim.state.nudgeAnchors);
      await sim.restart();
      expect(sim.state.providerSeenToolIds.size).toBe(0);
      expect(sim.state.nudgeAnchors).toEqual(anchors);
      const afterRestart = await sim.project("after-restart");
      expect(afterRestart.messages).toEqual(beforeRestart.messages);
      const report = sim.report();
      expect(report.toolReminderProviderTurns).toBe(1);
      expect(report.providerCapacityViolations).toBe(0);
      expect(report.aborts).toBe(0);
    } finally { sim.dispose(); }
  });
  test("single long turn: stale re-reads are suggested in-turn and compress surgically", async () => {
    const sim = await DcpSessionSimulator.create({
      contextWindow: 16_000,
      sessionId: "in-turn-stale-observations",
      configure(config) {
        config.debug = false;
        for (const strategy of Object.values(config.strategies)) strategy.enabled = false;
        config.compress.minContextPercent = 0.20;
        config.compress.maxContextPercent = 0.90;
        config.compress.summaryBuffer = false;
        config.compress.nudgeFrequency = 1;
        config.compress.autoCandidates.enabled = false;
        Object.assign(config.compress.messageMode, {
          enabled: true, minContextPercent: 0.20, keepRecentTurns: 1, mediumTokens: 300, highTokens: 100_000, maxSuggestions: 5,
        });
        config.compress.autoCompress.enabled = false;
        config.compress.autoCompress.summarizerModel = [];
        config.compress.autoCompress.summarizerFallbackModels = [];
      },
    });
    try {
      sim.appendUser("Refactor src/parser.ts. This is one long task.");
      const oldBody = `OLD_PARSER_BODY\n${"function oldParse() { return legacy(); }\n".repeat(160)}`;
      const lexer = `LEXER\n${"token();\n".repeat(400)}`;
      await sim.toolTurn({ toolName: "read", input: { path: "src/parser.ts" }, output: oldBody, label: "read-parser" });
      await sim.toolTurn({ toolName: "read", input: { path: "src/lexer.ts" }, output: lexer, label: "read-lexer" });
      await sim.toolTurn({ toolName: "edit", input: { path: "src/parser.ts", oldText: "legacy", newText: "modern" }, output: "Edited src/parser.ts", label: "edit" });
      await sim.toolTurn({ toolName: "read", input: { path: "src/lexer.ts" }, output: lexer, label: "read-lexer-again" });
      // Routine pressure is first crossed here; the reminder rides this fresh tool result.
      await sim.toolTurn({ toolName: "read", input: { path: "src/parser.ts", offset: 1 }, output: `NEW_PARSER_BODY\n${"function parse() { return modern(); }\n".repeat(160)}`, label: "read-parser-again" });
      const projected = await sim.project("stale-recommendation");
      const reminder = sim.state.nudgeAnchors[0]?.renderedReminder ?? "";
      expect(reminder).toContain("file changed later by a write/edit");
      expect(reminder).toContain("superseded by a later identical call");
      const suggested = [...reminder.matchAll(/(m\d+) \(high, toolResult, ~\d+ tokens, (?:file changed|superseded)/g)].map((match) => match[1]!);
      expect(suggested).toHaveLength(2);

      const { result } = await sim.compressTurn({
        topic: "Stale reads",
        messages: suggested.map((messageId) => ({ messageId, summary: "Superseded read; current content is in a later read." })),
      });
      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({ committed: true });
      expect(result.details.netGain).toBeGreaterThan(0);

      const after = await sim.project("after-stale-compress");
      const text = JSON.stringify(after.messages);
      expect(after.sample.projectedTokens).toBeLessThan(projected.sample.projectedTokens);
      expect(text).not.toContain("OLD_PARSER_BODY");
      expect(text).toContain("NEW_PARSER_BODY");
      expect(text).toContain("Refactor src/parser.ts");
      expect(sim.report()).toMatchObject({ aborts: 0, providerCapacityViolations: 0 });
    } finally { sim.dispose(); }
  });

  test("regret signals: re-running a compressed observation and recovery after compression are recorded", async () => {
    const sim = await DcpSessionSimulator.create({
      contextWindow: 64_000,
      sessionId: "compression-regret",
      configure(config) {
        config.debug = false;
        for (const strategy of Object.values(config.strategies)) strategy.enabled = false;
        config.compress.autoCompress.enabled = false;
      },
    });
    try {
      sim.appendUser("Inspect the config loader.");
      const body = (name: string) => `${name}\n${"const setting = load();\n".repeat(200)}`;
      await sim.toolTurn({ toolName: "read", input: { path: "src/config.ts" }, output: body("CONFIG_BODY"), label: "read-config" });
      await sim.toolTurn({ toolName: "read", input: { path: "src/loader.ts" }, output: body("LOADER_BODY"), label: "read-loader" });
      const configId = [...sim.state.messageMetaSnapshot].find(([, meta]) => meta.text?.includes("CONFIG_BODY"))![0];
      const { result } = await sim.compressTurn({ topic: "Config read", messages: [{ messageId: configId, summary: "config.ts loads settings via load()." }] });
      expect(result.details).toMatchObject({ committed: true });
      expect(sim.report()).toMatchObject({ regretRefetches: 0, regretRecoveryCalls: 0 });

      await sim.toolTurn({ toolName: "read", input: { path: "src/loader.ts" }, output: body("LOADER_BODY"), label: "visible-reread" });
      await sim.toolTurn({ toolName: "read", input: { path: "src/other.ts" }, output: "other", label: "fresh-read" });
      expect(sim.report()).toMatchObject({ regretRefetches: 0 });
      await sim.toolTurn({ toolName: "read", input: { path: "src/config.ts" }, output: body("CONFIG_BODY"), label: "regret-reread" });
      await sim.toolTurn({ toolName: "session", input: { action: "name", name: "Explicit title" }, output: "renamed", label: "rename" });
      await sim.toolTurn({ toolName: "session", input: { action: "name" }, output: "Explicit title", label: "title-read" });
      expect(sim.report()).toMatchObject({ regretRefetches: 1, regretRecoveryCalls: 0 });
      await sim.toolTurn({ toolName: "session", input: { action: "search", query: "CONFIG_BODY" }, output: "match", label: "recovery" });
      expect(sim.report()).toMatchObject({ regretRefetches: 1, regretRecoveryCalls: 1 });
      expect(formatDcpStatistics({ branch: sim.branch() })).toContain(
        "Regret signals: 1 re-runs of compressed/pruned observations; 1 session-recovery calls after compression",
      );
    } finally { sim.dispose(); }
  });

  test("coding marathon: repeated failing test runs, reads and edits stay compact with extractive auto-compression", async () => {
    const sim = await DcpSessionSimulator.create({
      contextWindow: 24_000, maxOutputTokens: 1_000, sessionId: "coding-marathon",
      configure(config: any) {
        config.debug = false;
        config.compress.minContextPercent = 0.30;
        config.compress.maxContextPercent = 0.60;
        config.compress.summaryBuffer = false;
        config.compress.nudgeFrequency = 1;
        Object.assign(config.compress.autoCandidates, { enabled: true, minContextPercent: 0.30, keepRecentTurns: 1, minMessages: 2, minTokens: 100 });
        Object.assign(config.compress.messageMode, { enabled: true, minContextPercent: 0.30, keepRecentTurns: 1 });
        config.compress.autoCompress = { enabled: true, patience: 0, summarizerModel: [], summarizerFallbackModels: [], timeoutMs: 5_000 };
        Object.assign(config.strategies.emergencyCurrentTurnPruning, { enabled: true, hardContextPercent: 0.82, targetContextPercent: 0.65, patience: 1, keepRecentToolPairs: 4, minOutputTokens: 100 });
      },
    });
    const source = (file: string, round: number) => `// ${file} r${round}\n` + Array.from({ length: 120 }, (_, i) => `  test("case ${i} error status", () => expect(run${i}()).toBe("ok"))`).join("\n");
    const failing = (round: number) => `bun test v1\n` + Array.from({ length: 80 }, (_, i) => i % 4 === 0 ? `(fail) parser.test.ts > case ${i} ROUND_${round}_FAIL\n  error: expected ok` : `  at frame${i} (src/parser.ts:${i})`).join("\n") + `\n 40 pass\n 20 fail\n`;
    try {
      for (let turn = 0; turn < 4; turn++) {
        sim.appendUser(`Task ${turn}: fix parser area ${turn}. Constraint: TURN_${turn}_CONSTRAINT must hold.`);
        for (let round = 0; round < 4; round++) {
          await sim.toolTurn({ toolName: "read", input: { path: `src/area${turn}.ts` }, output: `Decision: AREA_${turn}_DECISION\n${source(`area${turn}`, round)}` });
          await sim.toolTurn({ toolName: "bash", input: { command: "bun test test/parser.test.ts" }, output: failing(turn * 10 + round), isError: true });
          await sim.toolTurn({ toolName: "edit", input: { path: `src/area${turn}.ts`, oldText: "a".repeat(400), newText: "b".repeat(400) }, output: `Edited src/area${turn}.ts` });
        }
        await sim.toolTurn({ toolName: "bash", input: { command: "bun test test/parser.test.ts" }, output: " 60 pass\n 0 fail\n" });
        await sim.assistantTurn(`Area ${turn} done.`);
      }
      const final = await sim.project("final");
      const text = JSON.stringify(final.messages);
      const report = sim.report();
      expect(report).toMatchObject({ aborts: 0, providerCapacityViolations: 0 });
      expect(report.compressionCommits).toBeGreaterThan(5);
      expect(report.peakProjectedContextPercent).toBeLessThan(0.6);
      expect(report.activeSummaryTokens).toBeLessThan(8_000);
      expect(report.maxBlockSummaryTokens).toBeLessThan(1_500);
      expect(report.tokenOccurrenceReductionPercent).toBeGreaterThan(60);
      expect(report.nonRewritePrefixRetentionMean).toBeGreaterThan(0.95);
      expect(text).not.toContain("sha256:");
      // Failures fixed in completed turns survive only in the raw session; the live
      // last turn (rounds 30-33) is still protected and stays raw.
      const failRounds = [...text.matchAll(/ROUND_(\d+)_FAIL/g)].map((match) => Number(match[1]));
      expect(failRounds.every((round) => round >= 30)).toBe(true);
      for (const turn of [0, 1, 2, 3]) {
        expect(text).toContain(`TURN_${turn}_CONSTRAINT`);
        expect(text).toContain(`AREA_${turn}_DECISION`);
      }
    } finally { sim.dispose(); }
  }, 120_000);

  test("keeps a long tool-heavy session bounded while materially reducing provider-token occurrences", async () => {
    const sim = await DcpSessionSimulator.create({
      contextWindow: 20_000,
      maxOutputTokens: 1_000,
      sessionId: "efficiency-long-session",
      configure: configureEfficiencyScenario,
    });
    try {
      sim.appendUser("Implement the feature. Preserve every explicit SESSION_SIM_FACT decision across the whole session.");
      for (let index = 0; index < 80; index++) {
        await sim.toolTurn({
          toolName: "read",
          input: { path: `/repo/file-${index}.ts`, offset: 1, limit: 200 },
          output: toolOutput(index),
          label: `inspection-${index}`,
        });
      }
      await sim.assistantTurn("Implementation complete; retain the recorded constraints.", "final-answer");
      const finalProjection = await sim.project("final-projection");
      const rendered = JSON.stringify(finalProjection.messages);
      for (const index of [0, 15, 30, 45, 60, 75]) {
        expect(rendered).toContain(`SESSION_SIM_FACT_${index}_MUST_SURVIVE`);
      }

      const report = sim.report();
      expect(report.turns).toBeGreaterThanOrEqual(80);
      expect(report.compressionCommits).toBeGreaterThanOrEqual(3);
      expect(report.aborts).toBe(0);
      expect(report.peakRawTokens).toBeGreaterThan(report.peakProjectedTokens);
      expect(report.peakProjectedContextPercent).toBeLessThan(0.82);
      expect(report.tokenOccurrenceReductionPercent).toBeGreaterThan(25);
      expect(report.blockOnlyConsolidations).toBeGreaterThan(0);
      expect(report.mixedBlockRawRollups).toBe(0);
      expect(report.peakActiveBlocks).toBeLessThanOrEqual(8);
      expect(report.maxBlockSummaryTokens).toBeLessThan(5_000);
      expect(report.nonRewritePrefixRetentionMean).toBeGreaterThan(0.70);
      expect(report.providerCapacityViolations).toBe(0);
      expect(report.journalEntries).toBeGreaterThan(report.compressionCommits);
    } finally {
      sim.dispose();
    }
  }, 30_000);

  test("replays journal state across restart without rebuilding an ever-growing summary ladder", async () => {
    const sim = await DcpSessionSimulator.create({
      contextWindow: 16_000,
      maxOutputTokens: 800,
      sessionId: "efficiency-journal-restart",
      configure: configureEfficiencyScenario,
    });
    try {
      sim.appendUser("Continue one long task across restart; old compressed work must stay compact.");
      for (let index = 0; index < 36; index++) {
        await sim.toolTurn({ output: toolOutput(index), label: `before-restart-${index}` });
      }
      expect(sim.state.compressionBlocks.length).toBeGreaterThan(0);
      const activeBeforeRestart = sim.state.compressionBlocks
        .filter((block) => block.active)
        .map((block) => ({ id: block.id, summaryTokenEstimate: block.summaryTokenEstimate }));
      expect(activeBeforeRestart.length).toBeGreaterThan(0);

      await sim.restart();
      expect(sim.state.compressionBlocks
        .filter((block) => block.active)
        .map((block) => ({ id: block.id, summaryTokenEstimate: block.summaryTokenEstimate })))
        .toEqual(activeBeforeRestart);

      for (let index = 36; index < 76; index++) {
        await sim.toolTurn({ output: toolOutput(index), label: `after-restart-${index}` });
      }
      await sim.assistantTurn("Done after restart.", "post-restart-final");
      const finalProjection = await sim.project("post-restart-projection");
      const rendered = JSON.stringify(finalProjection.messages);
      for (const index of [0, 15, 30, 45, 60, 75]) {
        expect(rendered).toContain(`SESSION_SIM_FACT_${index}_MUST_SURVIVE`);
      }

      const report = sim.report();
      expect(report.compressionCommits).toBeGreaterThan(1);
      expect(report.blockOnlyConsolidations).toBeGreaterThan(0);
      expect(report.mixedBlockRawRollups).toBe(0);
      expect(report.peakActiveBlocks).toBeLessThanOrEqual(8);
      expect(report.maxBlockSummaryTokens).toBeLessThan(5_000);
      expect(report.peakProjectedContextPercent).toBeLessThan(0.82);
      expect(report.tokenOccurrenceReductionPercent).toBeGreaterThan(20);
      expect(report.providerCapacityViolations).toBe(0);
      expect(report.aborts).toBe(0);
    } finally {
      sim.dispose();
    }
  }, 30_000);
});
