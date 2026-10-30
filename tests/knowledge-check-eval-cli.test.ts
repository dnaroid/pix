import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseKnowledgeEvalArguments, runKnowledgeEval } from "../scripts/knowledge-check-eval/run.js";

describe("Wiki contradiction evaluation CLI", () => {
  it("defaults to a plan without network requests", () => {
    const options = parseKnowledgeEvalArguments([]);
    assert.equal(options.live, false);
    assert.equal(options.mode, "judge");
    assert.equal(options.thinking, "low");
    assert.equal(options.selected.length, 16);
    assert.equal(options.repetitions, 1);
  });

  it("requires an explicit model for live evaluation", () => {
    assert.throws(() => parseKnowledgeEvalArguments(["--live"]), /explicit --model/u);
    const options = parseKnowledgeEvalArguments(["--live", "--model", "zai/glm-5.3-flash", "--mode", "all"]);
    assert.equal(options.modelRef, "zai/glm-5.3-flash");
    assert.equal(options.mode, "all");
  });

  it("rejects unknown, empty and incompatible options", () => {
    for (const args of [["--mode", "invalid"], ["--thinking", "invalid"], ["--cases", "unknown"], ["--cases", ""], ["--unexpected"]]) {
      assert.throws(() => parseKnowledgeEvalArguments(args));
    }
  });

  it("bounds repetitions, requests and time independently", () => {
    for (const args of [["--repeat", "4"], ["--max-calls", "65"], ["--timeout-ms", "180001"], ["--budget-ms", "3600001"], ["--repeat", "0"], ["--max-calls", "1.5"]]) {
      assert.throws(() => parseKnowledgeEvalArguments(args), /Invalid/u);
    }
  });

  it("selects stable fixture IDs without duplicating requests", () => {
    const options = parseKnowledgeEvalArguments(["--cases", "exact-number,paraphrased,exact-number"]);
    assert.deepEqual(options.selected.map(item => item.id), ["exact-number", "paraphrased"]);
    assert.equal(options.explicitCases, true);
  });

  it("rejects an insufficient call budget before opening a model runtime", async () => {
    await assert.rejects(runKnowledgeEval(["--live", "--model", "zai/glm-5.3-flash", "--mode", "all", "--max-calls", "1"]),
      /Plan needs 21 model calls|PI_OFFLINE/u);
  });
});
