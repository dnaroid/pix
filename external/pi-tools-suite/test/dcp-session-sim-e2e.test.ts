import { describe, expect, test } from "bun:test";
import { prepareDcpReminderScenario } from "./support/dcp-reminder-scenario.js";

import { DcpSessionSimulator } from "./support/dcp-session-simulator.js";

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
