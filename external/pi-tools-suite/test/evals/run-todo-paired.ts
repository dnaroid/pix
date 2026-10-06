import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { resolveEvalOutputDir } from "./harness/output-dir.js";
import { parseEvalModels, runEvalCase } from "./harness/runner.js";
import type { EvalRunResult } from "./harness/types.js";
import { scoreTodoConciseness, TODO_CONCISENESS_CASES, type TodoStage } from "./todo-conciseness.js";
import { createTodoPromptSnapshots, type TodoPromptVariant } from "./todo-prompt-snapshots.js";

const rescoreDir = process.env.PI_TODO_EVAL_RESCORE_DIR;
const saved = rescoreDir ? JSON.parse(fs.readFileSync(path.join(rescoreDir, "comparison.json"), "utf8")) as { models: string[]; repeats: number; startedAt: string; complete: boolean; rows: Row[] } : undefined;
if (saved && !saved.complete) throw new Error("Wait until the live comparison is complete before rescoring.");
const models = saved?.models ?? parseEvalModels();
const repeats = saved?.repeats ?? Number(process.env.PI_TODO_EVAL_REPEATS ?? 3);
const timeoutMs = Number(process.env.PI_TOOLS_SUITE_EVAL_TIMEOUT_MS ?? 240_000);
if (models.length === 0 || !Number.isInteger(repeats) || repeats < 1 || repeats > 5 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
	throw new Error("Set PI_TOOLS_SUITE_EVAL_MODELS; PI_TODO_EVAL_REPEATS must be 1–5 and timeout must be positive.");
}
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = rescoreDir ?? resolveEvalOutputDir("todo-paired", process.env.PI_TOOLS_SUITE_EVAL_OUTPUT_DIR);
const entrypoints = saved ? undefined : createTodoPromptSnapshots(packageRoot, outputDir);
const startedAt = saved?.startedAt ?? new Date().toISOString();
const scorerSource = fs.readFileSync(path.join(packageRoot, "test/evals/todo-conciseness.ts"), "utf8");
const scorerHash = createHash("sha256").update(scorerSource).digest("hex");
const rescoredAt = saved ? new Date().toISOString() : undefined;
if (saved && !fs.existsSync(path.join(outputDir, "raw-live-comparison.json"))) fs.copyFileSync(path.join(outputDir, "comparison.json"), path.join(outputDir, "raw-live-comparison.json"));
fs.writeFileSync(path.join(outputDir, "final-scorer.ts"), scorerSource);
type Row = {
	model: string; repeat: number; variant: TodoPromptVariant; caseId: string;
	executionOk: boolean; brevity: boolean; lifecycle: boolean; maxDescription: number;
	brevityErrors: string[]; lifecycleErrors: string[]; result: EvalRunResult;
};
const rows: Row[] = saved?.rows ?? [];

function saveReport(complete: boolean): void {
	fs.writeFileSync(path.join(outputDir, "comparison.json"), JSON.stringify({ startedAt, updatedAt: new Date().toISOString(), complete, repeats, models, scorerHash, rescoredAt, rows }, null, 2) + "\n");
	const lines = ["# Todo prompt comparison", "", `Complete: ${complete}. ${repeats} repeats per model × four independent cases × two frozen prompt variants.`, "",
		"Brevity and lifecycle are independent gates. Execution failures/timeouts count as failures in both. Alternating pair order; fresh fixture/session per run. Small descriptive sample, not statistical proof. No runtime length guard.", "",
		"| Model | Variant | Runs | Brevity | Lifecycle | Both | Max description | Timeouts | Cost |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"];
	if (rescoredAt) lines.splice(5, 0, `Rescored retained events at ${rescoredAt}; raw live assertions remain in each result and raw-live-comparison.json. No new model calls. Final scorer SHA-256: ${scorerHash}.`, "");
	for (const model of models) for (const variant of ["brief", "strengthened"] as const) {
		const group = rows.filter((row) => row.model === model && row.variant === variant);
		lines.push(`| ${model} | ${variant} | ${group.length} | ${group.filter((row) => row.brevity).length} | ${group.filter((row) => row.lifecycle).length} | ${group.filter((row) => row.brevity && row.lifecycle).length} | ${Math.max(0, ...group.map((row) => row.maxDescription))} | ${group.filter((row) => row.result.timedOut).length} | $${group.reduce((sum, row) => sum + row.result.metrics.parentUsage.cost + row.result.metrics.subagentUsage.cost, 0).toFixed(4)} |`);
	}
	lines.push("", "## Paired results", "", "| Model | Repeat | Case | Brief brevity/lifecycle | Strengthened brevity/lifecycle |", "| --- | ---: | --- | --- | --- |");
	for (const model of models) for (let repeat = 1; repeat <= repeats; repeat++) for (const evalCase of TODO_CONCISENESS_CASES) {
		const pair = rows.filter((row) => row.model === model && row.repeat === repeat && row.caseId === evalCase.id);
		const cell = (variant: TodoPromptVariant): string => {
			const row = pair.find((row) => row.variant === variant);
			return row ? `${row.brevity ? "PASS" : "FAIL"}/${row.lifecycle ? "PASS" : "FAIL"}` : "not run";
		};
		lines.push(`| ${model} | ${repeat} | ${evalCase.id} | ${cell("brief")} | ${cell("strengthened")} |`);
	}
	fs.writeFileSync(path.join(outputDir, "comparison.md"), lines.join("\n") + "\n");
}

// Independent provider tracks, at most two live sessions. Persist every completed run.
async function runModel(model: string, modelIndex: number): Promise<void> {
	for (let repeat = 1; repeat <= repeats; repeat++) for (const [caseIndex, evalCase] of TODO_CONCISENESS_CASES.entries()) {
		const order: TodoPromptVariant[] = (repeat + caseIndex + modelIndex) % 2 ? ["brief", "strengthened"] : ["strengthened", "brief"];
		for (const variant of order) {
			const result = await runEvalCase(evalCase, model, { timeoutMs, extensionEntrypoint: entrypoints![variant] });
			const scores = scoreTodoConciseness(result, evalCase.id.replace("tool.todo-concise-", "") as TodoStage);
			const descriptions: number[] = [];
			for (const event of result.events) {
				if (event.type !== "tool_call" || event.toolName !== "todo") continue;
				const input = event.input as { description?: unknown; items?: { description?: unknown }[] } | undefined;
				for (const item of Array.isArray(input?.items) ? input.items : [input]) if (typeof item?.description === "string") descriptions.push([...item.description].length);
			}
			const executionOk = result.exitCode === 0 && !result.timedOut && result.events.some((event) => event.type === "tool_call" && event.toolName === "todo");
			rows.push({ model, repeat, variant, caseId: evalCase.id, executionOk, brevity: executionOk && scores.brevityErrors.length === 0, lifecycle: executionOk && scores.lifecycleErrors.length === 0, maxDescription: Math.max(0, ...descriptions), ...scores, result });
			saveReport(false);
		}
	}
}

if (saved) {
	for (const row of rows) {
		const scores = scoreTodoConciseness(row.result, row.caseId.replace("tool.todo-concise-", "") as TodoStage);
		Object.assign(row, scores, { brevity: row.executionOk && scores.brevityErrors.length === 0, lifecycle: row.executionOk && scores.lifecycleErrors.length === 0 });
	}
} else {
	saveReport(false);
	for (let offset = 0; offset < models.length; offset += 2) {
		await Promise.all(models.slice(offset, offset + 2).map((model, index) => runModel(model, offset + index)));
	}
}
saveReport(true);
console.log(`Report: ${path.join(outputDir, "comparison.md")}`);
if (rows.some((row) => !row.brevity || !row.lifecycle)) process.exitCode = 1;
