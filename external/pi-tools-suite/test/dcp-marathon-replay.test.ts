import { describe, expect, test } from "bun:test";
import type { DcpConfig } from "../src/dcp/config.js";
import { createAutoCompressionBlock } from "../src/dcp/auto-compress.js";
import { applyPruning, detectEmergencyCompressionCandidate } from "../src/dcp/pruner.js";
import { compressionPlanningTokens } from "../src/dcp/compression-progress.js";
import { createState } from "../src/dcp/state.js";
import { buildDcpJournalDelta, createDcpJournalInit, createDcpJournalMirror, replayDcpJournal } from "../src/dcp/journal.js";
import { estimateMessageTokens } from "../src/dcp/pruner-metadata.js";

function replayConfig(): DcpConfig {
  return {
    enabled: true,
    debug: false,
    manualMode: { enabled: false },
    compress: {
      maxContextPercent: 0.65,
      minContextPercent: 0.4,
      modelMaxContextPercent: {},
      modelMinContextPercent: {},
      summaryBuffer: true,
      nudgeFrequency: 2,
      iterationNudgeThreshold: 8,
      nudgeForce: "soft",
      protectedTools: ["compress", "write", "edit"],
      protectTags: true,
      protectUserMessages: true,
      autoCandidates: {
        enabled: true,
        minContextPercent: 0.1,
        keepRecentTurns: 1,
        minMessages: 2,
        minTokens: 500,
      },
      messageMode: {
        enabled: false,
        minContextPercent: 0.1,
        keepRecentTurns: 1,
        mediumTokens: 500,
        highTokens: 5000,
        maxSuggestions: 5,
      },
      autoCompress: {
        enabled: true,
        patience: 0,
        summarizerModel: [],
        summarizerFallbackModels: [],
        timeoutMs: 1000,
      },
    },
    strategies: {
      emergencyCurrentTurnPruning: {
        enabled: true,
        hardContextPercent: 0.82,
        targetContextPercent: 0.7,
        patience: 0,
        keepRecentToolPairs: 8,
        minOutputTokens: 100,
        maxSuggestions: 8,
        protectedTools: [],
      },
    },
    protectedFilePatterns: [],
    modelOverrides: {},
  };
}

function user(text: string, timestamp: number): any {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function toolCall(id: string, timestamp: number): any {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", input: { path: `/repo/${id}.txt` } }],
    timestamp,
  };
}

function toolResult(id: string, marker: string, timestamp: number): any {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    isError: false,
    content: [{ type: "text", text: `${marker}\n${"x".repeat(2_000)}` }],
    timestamp,
  };
}

function renderedText(messages: any[]): string {
  return messages.flatMap((message) => Array.isArray(message?.content) ? message.content : [])
    .map((part: any) => typeof part?.text === "string" ? part.text : "")
    .join("\n");
}

function projectedTokens(messages: any[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

describe("DCP marathon replay", () => {
  test("one user turn sustains 10 useful auto rollups across 1000 tool groups and restart", async () => {
    const cfg = replayConfig();
    const state = createState();
    const raw: any[] = [user(
      "ACTIVE_CONSTRAINT_KEEP_API_STABLE. NEXT_STEP_CONTINUE_IMPLEMENTATION. <protect>DO_NOT_CHANGE_PUBLIC_API</protect>",
      1,
    )];
    let timestamp = 10;
    let totalGroups = 0;
    let previousProjectedTokens = 0;
    const gains: number[] = [];
    const summarySizes: number[] = [];

    for (let cycle = 0; cycle < 10; cycle++) {
      for (let local = 0; local < 100; local++) {
        const index = totalGroups++;
        const id = `marathon-${index}`;
        raw.push(toolCall(id, timestamp++));
        raw.push(toolResult(id, `RAW_GROUP_${index}`, timestamp++));
      }

      // Every result except the live tail has completed provider evidence by
      // the next planning point. This remains a single user turn throughout.
      const visibleCutoff = Math.max(0, totalGroups - cfg.strategies.emergencyCurrentTurnPruning.keepRecentToolPairs);
      for (let index = 0; index < visibleCutoff; index++) state.providerSeenToolIds.add(`marathon-${index}`);

      const before = applyPruning(raw, state, cfg);
      const beforeTokens = projectedTokens(before);
      if (cycle > 0) {
        // New work may raise the projection between cycles, but the previous
        // commit must have left a bounded rollup rather than recursively
        // reproducing all prior raw output.
        expect(beforeTokens).toBeLessThan(previousProjectedTokens + 80_000);
      }

      const candidate = detectEmergencyCompressionCandidate(
        before,
        state,
        cfg,
        0.90,
        0.65,
        { requiredSavingsTokens: 22_000 },
      );
      expect(candidate).not.toBe(null);
      expect(candidate?.reason).toContain("provider-evidenced prefix");

      const result = await createAutoCompressionBlock({
        candidate: candidate!,
        topic: `Marathon rollup ${cycle + 1}`,
        state,
        config: cfg,
        messages: before,
        requiredGainTokens: 1_000,
      });
      expect(result.projectedGain).toBeGreaterThanOrEqual(1_000);
      gains.push(result.projectedGain);

      const after = applyPruning(raw, state, cfg);
      const afterTokens = projectedTokens(after);
      expect(afterTokens).toBeLessThan(beforeTokens);
      expect(state.compressionBlocks.filter((block) => block.active)).toHaveLength(1);
      expect(state.compressionBlocks).toHaveLength(cycle + 1);
      expect(state.compressionBlocks.at(-1)?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(Array.isArray(state.compressionBlocks.at(-1)?.protectedFragments)).toBe(true);

      const text = renderedText(after);
      expect(text).toContain("ACTIVE_CONSTRAINT_KEEP_API_STABLE");
      expect(text).toContain("DO_NOT_CHANGE_PUBLIC_API");
      expect(text).toContain(`RAW_GROUP_${totalGroups - 1}`);
      expect(text).not.toContain("RAW_GROUP_0\n");
      // New rollups must not recursively embed previous summaries verbatim.
      expect((text.match(/\[Previously compressed:/g) ?? []).length).toBe(0);

      summarySizes.push(state.compressionBlocks.at(-1)?.summary.length ?? 0);
      previousProjectedTokens = afterTokens;
    }

    expect(totalGroups).toBe(1_000);
    expect(gains).toHaveLength(10);
    expect(gains.every((gain) => gain > 0)).toBe(true);
    // Summary size should be bounded by the extractive record, not grow with
    // the 1000 raw outputs or the number of rollups.
    expect(Math.max(...summarySizes)).toBeLessThan(20_000);

    const init = createDcpJournalInit("marathon-replay-init", 1);
    const mirror = createDcpJournalMirror(createState(), init.operationId);
    const delta = buildDcpJournalDelta(state, mirror, "marathon-replay-final", 2);
    expect(delta).toBeDefined();
    const restored = createState();
    replayDcpJournal([
      { type: "custom", customType: "dcp-journal", data: init },
      { type: "custom", customType: "dcp-journal", data: delta },
    ], restored);
    const afterRestart = applyPruning(raw, restored, cfg);
    const restartText = renderedText(afterRestart);

    expect(restored.compressionBlocks.filter((block) => block.active)).toHaveLength(1);
    expect(restored.compressionBlocks).toHaveLength(10);
    expect(restartText).toContain("ACTIVE_CONSTRAINT_KEEP_API_STABLE");
    expect(restartText).toContain("DO_NOT_CHANGE_PUBLIC_API");
    expect(restartText).toContain("RAW_GROUP_999");
    expect(restartText).not.toContain("RAW_GROUP_0\n");
    expect(projectedTokens(afterRestart)).toBe(previousProjectedTokens);
  }, 30_000);

  test("journal recovery pressure keeps existing summaries intact instead of recreating the incident rollup ladder", async () => {
    const cfg = replayConfig();
    const raw: any[] = [user(
      "INCIDENT_CONSTRAINT_KEEP_EXISTING_SUMMARY. NEXT_STEP_CONTINUE_RAW_TAIL_ONLY.",
      1,
    )];
    let timestamp = 10;
    let totalGroups = 0;
    const appendGroups = (count: number) => {
      for (let local = 0; local < count; local++) {
        const index = totalGroups++;
        const id = `incident-${index}`;
        raw.push(toolCall(id, timestamp++));
        raw.push(toolResult(id, `INCIDENT_RAW_GROUP_${index}`, timestamp++));
      }
    };

    const initial = createState();
    appendGroups(40);
    for (let index = 0; index < 32; index++) initial.providerSeenToolIds.add(`incident-${index}`);
    const initialProjection = applyPruning(raw, initial, cfg);
    const firstCandidate = detectEmergencyCompressionCandidate(
      initialProjection,
      initial,
      cfg,
      0.90,
      0.65,
      { requiredSavingsTokens: 8_000, allowCompressionBlocks: false },
    );
    expect(firstCandidate).not.toBeNull();
    const first = await createAutoCompressionBlock({
      candidate: firstCandidate!,
      topic: "Incident initial compression",
      state: initial,
      config: cfg,
      messages: initialProjection,
      requiredGainTokens: 1_000,
    });
    expect(first.projectedGain).toBeGreaterThan(0);
    expect(initial.compressionBlocks.filter((block) => block.active)).toHaveLength(1);

    // The incident happened after DCP moved from a sidecar snapshot to journal
    // replay, so continue from a journal-restored state rather than from the
    // original in-memory object.
    const init = createDcpJournalInit("incident-replay-init", 1);
    const mirror = createDcpJournalMirror(createState(), init.operationId);
    const delta = buildDcpJournalDelta(initial, mirror, "incident-replay-first", 2);
    expect(delta).toBeDefined();
    const state = createState();
    replayDcpJournal([
      { type: "custom", customType: "dcp-journal", data: init },
      { type: "custom", customType: "dcp-journal", data: delta },
    ], state);

    const firstBlockId = state.compressionBlocks.find((block) => block.active)?.id;
    const firstSummaryTokens = state.compressionBlocks.find((block) => block.id === firstBlockId)?.summaryTokenEstimate ?? 0;
    expect(firstBlockId).toBeDefined();

    const recoverySummaryTokens: number[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      appendGroups(12);
      const visibleCutoff = Math.max(0, totalGroups - cfg.strategies.emergencyCurrentTurnPruning.keepRecentToolPairs);
      for (let index = 0; index < visibleCutoff; index++) state.providerSeenToolIds.add(`incident-${index}`);

      const before = applyPruning(raw, state, cfg);
      // Reproduce the incident shape: progress accounting can carry a very
      // large historical debt even though this provider pass only needs a much
      // smaller amount of recovery.
      state.compressionProgress = {
        projectedTokens: projectedTokens(before),
        observedTokens: 145_000 + cycle * 100,
        targetHeadroomTokens: 112_000,
        contextWindow: 272_000,
        remainingTokens: 120_000 + cycle * 2_000,
        kind: "emergency",
      };
      const progressInput = {
        projectedTokens: projectedTokens(before) + 200,
        observedTokens: 145_100 + cycle * 100,
        targetHeadroomTokens: 112_000,
        contextWindow: 272_000,
        requiredTokens: 3_000,
        kind: "emergency" as const,
      };
      const planningTokens = compressionPlanningTokens(state, progressInput);
      expect(planningTokens).toBe(3_000);

      const candidate = detectEmergencyCompressionCandidate(
        before,
        state,
        cfg,
        0.90,
        0.65,
        { requiredSavingsTokens: planningTokens, allowCompressionBlocks: false },
      );
      expect(candidate).not.toBeNull();
      expect(candidate!.includedBlockIds).toEqual([]);
      expect(candidate!.startId).not.toBe(`b${firstBlockId}`);

      const result = await createAutoCompressionBlock({
        candidate: candidate!,
        topic: `Incident recovery ${cycle + 1}`,
        state,
        config: cfg,
        messages: before,
        requiredGainTokens: planningTokens,
        allowPartialGain: true,
      });
      expect(result.projectedGain).toBeGreaterThan(0);
      const created = state.compressionBlocks.find((block) => block.id === result.blockId)!;
      expect(created.coveredBlockIds).toEqual([]);
      recoverySummaryTokens.push(created.summaryTokenEstimate);

      const preserved = state.compressionBlocks.find((block) => block.id === firstBlockId);
      expect(preserved?.active).toBe(true);
      expect(preserved?.summaryTokenEstimate).toBe(firstSummaryTokens);
    }

    // The real regression grew one replacement summary from ~19k to ~40k while
    // each later pass added only a tiny raw tail. Recovery summaries here must
    // remain local to their raw slice and never form that summary-on-summary
    // ladder.
    expect(state.compressionBlocks.filter((block) => block.active).length).toBeGreaterThan(1);
    expect(Math.max(...recoverySummaryTokens)).toBeLessThan(Math.max(8_000, firstSummaryTokens));
    expect(state.compressionBlocks.slice(1).every((block) => (block.coveredBlockIds ?? []).length === 0)).toBe(true);
  }, 30_000);
});
