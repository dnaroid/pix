import * as fs from "node:fs";
import * as path from "node:path";
import type { EvalReport, EvalRunResult } from "./types.js";

export function writeEvalReport(report: EvalReport, outputDir: string): { jsonPath: string; markdownPath: string } {
	fs.mkdirSync(outputDir, { recursive: true });
	const jsonPath = path.join(outputDir, "eval-report.json");
	const markdownPath = path.join(outputDir, "eval-report.md");
	fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
	fs.writeFileSync(markdownPath, renderEvalReportMarkdown(report), "utf8");
	return { jsonPath, markdownPath };
}

export function renderEvalReportMarkdown(report: EvalReport): string {
	const lines = [
		"# Pi Tools Suite Eval Report",
		"",
		`Started: ${report.startedAt}`,
		`Finished: ${report.finishedAt}`,
		`Models: ${report.models.join(", ") || "none"}`,
		"",
		"| Model | Pass | Cases | Parent tokens | Worker tokens | Cost | Tool calls | Time |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const model of report.models) {
		const results = report.results.filter((result) => result.model === model);
		const passed = results.filter((result) => result.passed).length;
		lines.push(`| ${escapeCell(model)} | ${passed} | ${results.length} | ${sum(results, "parentTokens")} | ${sum(results, "workerTokens")} | $${sumCost(results).toFixed(4)} | ${sum(results, "toolCalls")} | ${formatMs(sum(results, "elapsed"))} |`);
	}
	lines.push("", "## Cases", "", "| Case | Model | Result | Tools | Files | Tokens (parent/worker) | Time |", "| --- | --- | --- | --- | --- | ---: | ---: |");
	for (const result of report.results) {
		lines.push(`| ${escapeCell(result.caseId)} | ${escapeCell(result.model)} | ${result.passed ? "PASS" : "FAIL"} | ${escapeCell(result.metrics.toolCalls.join(" → "))} | ${escapeCell(result.metrics.changedFiles.join(", "))} | ${result.metrics.parentUsage.totalTokens}/${result.metrics.subagentUsage.totalTokens} | ${formatMs(result.metrics.elapsedMs)} |`);
	}
	const failures = report.results.filter((result) => !result.passed);
	if (failures.length > 0) {
		lines.push("", "## Failures", "");
		for (const result of failures) {
			lines.push(`### ${result.caseId} — ${result.model}`, "");
			for (const assertion of result.assertions.filter((item) => !item.passed)) lines.push(`- ${assertion.name}${assertion.detail ? `: ${assertion.detail}` : ""}`);
			lines.push("");
		}
	}
	return lines.join("\n") + "\n";
}

type SumMetric = "parentTokens" | "workerTokens" | "toolCalls" | "elapsed";
function sum(results: EvalRunResult[], metric: SumMetric): number {
	return results.reduce((total, result) => total + (
		metric === "parentTokens" ? result.metrics.parentUsage.totalTokens
			: metric === "workerTokens" ? result.metrics.subagentUsage.totalTokens
				: metric === "toolCalls" ? result.metrics.toolCallCount
					: result.metrics.elapsedMs
	), 0);
}
function sumCost(results: EvalRunResult[]): number { return results.reduce((total, result) => total + result.metrics.parentUsage.cost + result.metrics.subagentUsage.cost, 0); }
function formatMs(ms: number): string { return `${(ms / 1000).toFixed(1)}s`; }
function escapeCell(value: string): string { return value.replace(/\|/g, "\\|").replace(/\n/g, " "); }
