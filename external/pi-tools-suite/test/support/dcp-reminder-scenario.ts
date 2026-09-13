import { DcpSessionSimulator } from "./dcp-session-simulator.js";

/** The same real-hook/real-journal scene is used by deterministic and live tests. */
export async function prepareDcpReminderScenario() {
  const sim = await DcpSessionSimulator.create({
    contextWindow: 64_000,
    configure(config) {
      config.debug = false;
      config.compress.minContextPercent = 0.20;
      config.compress.maxContextPercent = 0.30;
      config.compress.summaryBuffer = false;
      config.compress.nudgeForce = "strong";
      config.compress.nudgeFrequency = 1;
      config.compress.autoCandidates.minTokens = 500;
      config.compress.autoCandidates.minMessages = 2;
      // Prove model-facing delivery without auto-compression doing the job.
      config.compress.autoCompress.enabled = false;
      config.compress.autoCompress.summarizerModel = [];
      config.compress.autoCompress.summarizerFallbackModels = [];
      config.strategies.emergencyCurrentTurnPruning.keepRecentToolPairs = 2;
    },
  });
  try {
    sim.appendUser("Investigate the queue retry issue. Keep the public API unchanged. Finish the code inspection, then run the focused queue test and report the result.");
    for (let index = 0; index < 8; index++) {
      await sim.toolTurn({ output: `Decision: file-${index}.ts needs no changes.\n${"inspection detail\n".repeat(200)}` });
    }
    const previous = await sim.project("before-large-result");
    await sim.toolTurn({
      output: `${"completed diagnostic output\n".repeat(2_300)}\nDecision: inspection is complete; keep the current queue implementation.\nNext step: run the focused queue test.`,
      label: "large-final-inspection",
    });
    const projected = await sim.project("reminder-on-fresh-result");
    return { sim, previous, projected };
  } catch (error) {
    sim.dispose();
    throw error;
  }
}
