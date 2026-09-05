import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { EVAL_CASES } from "./cases.js";
import { caseAppliesToModel, parseEvalModels, runEvalCase } from "./harness/runner.js";
import { writeEvalReport } from "./harness/report.js";
import type { EvalReport } from "./harness/types.js";

const models = parseEvalModels();
if (models.length === 0) {
	console.error("Set PI_TOOLS_SUITE_EVAL_MODELS to a comma-separated model matrix, e.g. zai/glm-5.3,openai-codex/gpt-5.6-terra.");
	process.exit(2);
}

const selectedIds = new Set((process.env.PI_TOOLS_SUITE_EVAL_CASES ?? "").split(/[;,\n]/).map((value) => value.trim()).filter(Boolean));
const selectedCategories = new Set((process.env.PI_TOOLS_SUITE_EVAL_CATEGORIES ?? "").split(/[;,\n]/).map((value) => value.trim()).filter(Boolean));
const timeoutMs = Number(process.env.PI_TOOLS_SUITE_EVAL_TIMEOUT_MS ?? 240_000);
const keepProject = /^(1|true|yes)$/i.test(process.env.PI_TOOLS_SUITE_EVAL_KEEP ?? "");
const streamIo = /^(1|true|yes)$/i.test(process.env.PI_TOOLS_SUITE_EVAL_STREAM_IO ?? "");
const outputDir = process.env.PI_TOOLS_SUITE_EVAL_OUTPUT_DIR
	? path.resolve(process.env.PI_TOOLS_SUITE_EVAL_OUTPUT_DIR)
	: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "artifacts", new Date().toISOString().replace(/[:.]/g, "-"));

const startedAt = new Date().toISOString();
const results = [];
for (const model of models) {
	for (const evalCase of EVAL_CASES) {
		if (!caseAppliesToModel(evalCase, model)) continue;
		if (selectedIds.size > 0 && !selectedIds.has(evalCase.id)) continue;
		if (selectedCategories.size > 0 && !selectedCategories.has(evalCase.category)) continue;
		process.stderr.write(`[eval] ${model} :: ${evalCase.id}\n`);
		const result = await runEvalCase(evalCase, model, { timeoutMs, keepProject, streamIo });
		results.push(result);
		process.stderr.write(`[eval] ${result.passed ? "PASS" : "FAIL"} ${model} :: ${evalCase.id} tools=${result.metrics.toolCallCount} parentTokens=${result.metrics.parentUsage.totalTokens} workerTokens=${result.metrics.subagentUsage.totalTokens}\n`);
	}
}

const report: EvalReport = { startedAt, finishedAt: new Date().toISOString(), models, results };
const artifacts = writeEvalReport(report, outputDir);
console.log(`JSON: ${artifacts.jsonPath}`);
console.log(`Markdown: ${artifacts.markdownPath}`);
console.log(`Passed: ${results.filter((result) => result.passed).length}/${results.length}`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
