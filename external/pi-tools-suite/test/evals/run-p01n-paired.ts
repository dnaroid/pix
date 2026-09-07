import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { EVAL_CASES } from "./cases.js";
import { caseAppliesToModel, parseEvalModels, runEvalCase } from "./harness/runner.js";
import type { EvalCase, EvalRunResult } from "./harness/types.js";

type Arm = "prompt-compact" | "native-compact";

type PairedResult = {
	model: string;
	caseId: string;
	promptCompact: EvalRunResult;
	nativeCompact: EvalRunResult;
	delta: {
		toolResultBytes: number;
		repoResultBytes: number;
		parentTokens: number;
		workerTokens: number;
		toolCalls: number;
		elapsedMs: number;
		nativeRefusals: number;
		nativeFullOverrides: number;
		retryAfterNativeRefusal: number;
	};
};

const DEFAULT_CASE_IDS = new Set([
	"tool.semantic-repo-search",
	"tool.architecture-first",
	"negative.known-file-read-no-oracle",
]);

const models = parseEvalModels();
if (models.length === 0) {
	console.error("Set PI_TOOLS_SUITE_EVAL_MODELS before running the P01-N paired live eval.");
	process.exit(2);
}

const configuredCases = new Set(
	(process.env.PI_TOOLS_SUITE_EVAL_CASES ?? "")
		.split(/[;,\n]/)
		.map((item) => item.trim())
		.filter(Boolean),
);
const selectedIds = configuredCases.size > 0 ? configuredCases : DEFAULT_CASE_IDS;
const selectedCases = EVAL_CASES.filter((evalCase) => selectedIds.has(evalCase.id));
if (selectedCases.length === 0) {
	console.error("No P01-N eval cases selected.");
	process.exit(2);
}

const timeoutMs = Number(process.env.PI_TOOLS_SUITE_EVAL_TIMEOUT_MS ?? 240_000);
const keepProject = /^(1|true|yes)$/i.test(process.env.PI_TOOLS_SUITE_EVAL_KEEP ?? "");
const streamIo = /^(1|true|yes)$/i.test(process.env.PI_TOOLS_SUITE_EVAL_STREAM_IO ?? "");
const seed = process.env.PI_TOOLS_SUITE_P01N_SEED ?? "p01n-2026-09-07";
const outputDir = process.env.PI_TOOLS_SUITE_EVAL_OUTPUT_DIR
	? path.resolve(process.env.PI_TOOLS_SUITE_EVAL_OUTPUT_DIR)
	: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "artifacts", `p01n-${new Date().toISOString().replace(/[:.]/g, "-")}`);

function armOrder(model: string, evalCase: EvalCase): Arm[] {
	let score = 0;
	for (const char of `${seed}\u0000${model}\u0000${evalCase.id}`) score = (score * 33 + char.charCodeAt(0)) >>> 0;
	return score % 2 === 0 ? ["prompt-compact", "native-compact"] : ["native-compact", "prompt-compact"];
}

async function runArm(arm: Arm, evalCase: EvalCase, model: string): Promise<EvalRunResult> {
	return runEvalCase(evalCase, model, {
		timeoutMs,
		keepProject,
		streamIo,
		env: {
			PI_REPO_DISCOVERY_PROFILE: arm === "native-compact" ? "native-compact" : "baseline",
		},
	});
}

function delta(prompt: EvalRunResult, native: EvalRunResult): PairedResult["delta"] {
	return {
		toolResultBytes: native.metrics.toolResultContentBytes - prompt.metrics.toolResultContentBytes,
		repoResultBytes: native.metrics.repoResultContentBytes - prompt.metrics.repoResultContentBytes,
		parentTokens: native.metrics.parentUsage.totalTokens - prompt.metrics.parentUsage.totalTokens,
		workerTokens: native.metrics.subagentUsage.totalTokens - prompt.metrics.subagentUsage.totalTokens,
		toolCalls: native.metrics.toolCallCount - prompt.metrics.toolCallCount,
		elapsedMs: native.metrics.elapsedMs - prompt.metrics.elapsedMs,
		nativeRefusals: native.metrics.nativePolicyRefusals,
		nativeFullOverrides: native.metrics.nativePolicyFullOverrides,
		retryAfterNativeRefusal: native.metrics.retryAfterNativeRefusalCount,
	};
}

function escapeCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function percentDelta(current: number, baseline: number): string {
	if (baseline === 0) return current === 0 ? "0.0%" : "n/a";
	return `${(((current - baseline) / baseline) * 100).toFixed(1)}%`;
}

function renderMarkdown(startedAt: string, finishedAt: string, pairs: PairedResult[]): string {
	const lines = [
		"# P01-N Paired Live Eval",
		"",
		`Started: ${startedAt}`,
		`Finished: ${finishedAt}`,
		`Seed: ${seed}`,
		"",
		"> This report compares the current Prompt Compact arm with the current Native Compact runtime arm. The historical pre-trim Baseline prompt is intentionally not reconstructed from an older full extension commit because that would mix unrelated code changes.",
		"",
		"| Case | Model | Prompt pass | Native pass | Repo bytes P→N | Parent tokens P→N | Calls P→N | Time P→N | Refusals/full/retries |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const pair of pairs) {
		const prompt = pair.promptCompact.metrics;
		const native = pair.nativeCompact.metrics;
		lines.push(
			`| ${escapeCell(pair.caseId)} | ${escapeCell(pair.model)} | ${pair.promptCompact.passed ? "PASS" : "FAIL"} | ${pair.nativeCompact.passed ? "PASS" : "FAIL"} | ${prompt.repoResultContentBytes}→${native.repoResultContentBytes} (${percentDelta(native.repoResultContentBytes, prompt.repoResultContentBytes)}) | ${prompt.parentUsage.totalTokens}→${native.parentUsage.totalTokens} (${percentDelta(native.parentUsage.totalTokens, prompt.parentUsage.totalTokens)}) | ${prompt.toolCallCount}→${native.toolCallCount} | ${(prompt.elapsedMs / 1000).toFixed(1)}s→${(native.elapsedMs / 1000).toFixed(1)}s | ${native.nativePolicyRefusals}/${native.nativePolicyFullOverrides}/${native.retryAfterNativeRefusalCount} |`,
		);
	}
	return lines.join("\n") + "\n";
}

const startedAt = new Date().toISOString();
const pairs: PairedResult[] = [];
for (const model of models) {
	for (const evalCase of selectedCases) {
		if (!caseAppliesToModel(evalCase, model)) continue;
		const results = new Map<Arm, EvalRunResult>();
		for (const arm of armOrder(model, evalCase)) {
			process.stderr.write(`[p01n] ${model} :: ${evalCase.id} :: ${arm}\n`);
			const result = await runArm(arm, evalCase, model);
			results.set(arm, result);
			process.stderr.write(
				`[p01n] ${result.passed ? "PASS" : "FAIL"} ${arm} bytes=${result.metrics.repoResultContentBytes} tools=${result.metrics.toolCallCount} tokens=${result.metrics.parentUsage.totalTokens} refusals=${result.metrics.nativePolicyRefusals}\n`,
			);
		}
		const promptCompact = results.get("prompt-compact")!;
		const nativeCompact = results.get("native-compact")!;
		pairs.push({ model, caseId: evalCase.id, promptCompact, nativeCompact, delta: delta(promptCompact, nativeCompact) });
	}
}

const finishedAt = new Date().toISOString();
fs.mkdirSync(outputDir, { recursive: true });
const jsonPath = path.join(outputDir, "p01n-paired-report.json");
const markdownPath = path.join(outputDir, "p01n-paired-report.md");
fs.writeFileSync(jsonPath, JSON.stringify({ startedAt, finishedAt, seed, models, pairs }, null, 2) + "\n", "utf8");
fs.writeFileSync(markdownPath, renderMarkdown(startedAt, finishedAt, pairs), "utf8");

console.log(`JSON: ${jsonPath}`);
console.log(`Markdown: ${markdownPath}`);
console.log(`Pairs: ${pairs.length}`);
if (pairs.some((pair) => !pair.promptCompact.passed || !pair.nativeCompact.passed)) process.exitCode = 1;
