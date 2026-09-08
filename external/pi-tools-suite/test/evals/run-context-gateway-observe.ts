import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEvalModels, runEvalCase } from "./harness/runner.js";
import type { EvalCase, EvalRunResult } from "./harness/types.js";
import type {
	ContextGatewayBudgets,
	ContextGatewayClassTelemetry,
	ContextGatewayTelemetrySnapshot,
	ContextGatewayToolClass,
} from "../../src/context-gateway/types.js";

const LARGE_LINE_COUNT = 2_300;
const OBSERVE_MAX_RESULT_BYTES = 8_192;
const BODY_SENTINELS = [
	"CG_OBSERVE_READ_BODY_SENTINEL",
	"CG_OBSERVE_BASH_BODY_SENTINEL",
	"CG_OBSERVE_AST_BODY_SENTINEL",
];

const DIRECT_DISCOVERY_TOOLS = [
	"repo_architecture",
	"repo_search",
	"repo_structure",
	"repo_ast",
	"repo_explain",
	"repo_deps",
	"todo",
	"subagents",
	"async_subagents_spawn",
];

const OBSERVE_CASES: EvalCase[] = [
	{
		id: "observe.residual-large-read",
		category: "negative",
		description: "Observe one default built-in Read result after its upstream truncation boundary.",
		fixture: "demo",
		prompt: "Call the Read tool exactly once on `large-read.txt` with no offset and no limit. Do not continue, page, search, or use shell after that call. Then answer only `observed read`.",
		assert: {
			firstToolOneOf: ["read", "Read"],
			forbiddenTools: [...DIRECT_DISCOVERY_TOOLS, "bash", "Bash", "shell", "shell_command", "ast_grep"],
			maxToolCalls: 1,
		},
	},
	{
		id: "observe.residual-large-bash",
		category: "negative",
		description: "Observe one built-in shell result with native tail truncation.",
		fixture: "demo",
		prompt: "Use Bash/shell exactly once to run `node emit-large.mjs`. Do not read files, search, retry, or run another command after it. Then answer only `observed bash`.",
		assert: {
			firstToolOneOf: ["bash", "Bash", "shell", "shell_command"],
			forbiddenTools: [...DIRECT_DISCOVERY_TOOLS, "read", "Read", "ast_grep"],
			maxToolCalls: 1,
		},
	},
	{
		id: "observe.residual-large-ast-grep",
		category: "negative",
		description: "Observe one real ast_grep result with many structural matches.",
		fixture: "demo",
		prompt: "Call `ast_grep` exactly once with command=run, pattern=`helper($A)`, lang=ts, and paths=[`src/ast-many.ts`]. Do not use any other tool and do not retry after the result. Then answer only `observed ast`.",
		assert: {
			firstTool: "ast_grep",
			forbiddenTools: [...DIRECT_DISCOVERY_TOOLS, "read", "Read", "bash", "Bash", "shell", "shell_command"],
			maxToolCalls: 1,
		},
	},
];

const models = parseEvalModels();
if (models.length === 0) {
	console.error("Set PI_TOOLS_SUITE_EVAL_MODELS before running Context Gateway observe evidence.");
	process.exit(2);
}

const timeoutMs = Number(process.env.PI_TOOLS_SUITE_EVAL_TIMEOUT_MS ?? 240_000);
const streamIo = /^(1|true|yes)$/i.test(process.env.PI_TOOLS_SUITE_EVAL_STREAM_IO ?? "");
const outputDir = process.env.PI_TOOLS_SUITE_EVAL_OUTPUT_DIR
	? path.resolve(process.env.PI_TOOLS_SUITE_EVAL_OUTPUT_DIR)
	: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "artifacts", `context-gateway-observe-${new Date().toISOString().replace(/[:.]/g, "-")}`);

function prepareResidualProject(projectDir: string): void {
	const readLines = [
		BODY_SENTINELS[0]!,
		...Array.from({ length: LARGE_LINE_COUNT }, (_, index) => `read-${String(index).padStart(4, "0")}-${"r".repeat(48)}`),
		"CG_OBSERVE_READ_TAIL",
	];
	fs.writeFileSync(path.join(projectDir, "large-read.txt"), readLines.join("\n"), "utf8");

	fs.writeFileSync(path.join(projectDir, "emit-large.mjs"), [
		`console.log(${JSON.stringify(BODY_SENTINELS[1])});`,
		`for (let i = 0; i < ${LARGE_LINE_COUNT}; i += 1) console.log(\`bash-\${String(i).padStart(4, "0")}-\${"b".repeat(48)}\`);`,
		"console.log('CG_OBSERVE_BASH_TAIL');",
	].join("\n") + "\n", "utf8");

	const astLines = [
		`const marker = ${JSON.stringify(BODY_SENTINELS[2])};`,
		"function helper<T>(value: T): T { return value; }",
		...Array.from({ length: 900 }, (_, index) => `export function astCase${index}() { return helper(${index}); }`),
		"void marker;",
	];
	fs.writeFileSync(path.join(projectDir, "src", "ast-many.ts"), astLines.join("\n") + "\n", "utf8");

	const piDir = path.join(projectDir, ".pi");
	fs.mkdirSync(piDir, { recursive: true });
	fs.writeFileSync(path.join(piDir, "pi-tools-suite.jsonc"), JSON.stringify({
		contextGateway: {
			mode: "observe",
			budgets: {
				maxInlineBytes: 8_192,
				maxResultBytes: OBSERVE_MAX_RESULT_BYTES,
				maxExactReadBytes: 32_768,
				maxSearchBytes: 8_192,
				maxSearchMatches: 12,
			},
		},
		repoDiscovery: { profile: "native-compact" },
	}, null, 2) + "\n", "utf8");
}

type SafeClassTelemetry = Pick<ContextGatewayClassTelemetry,
	"results" | "errors" | "contentBytes" | "deliveredContentBytes" | "textBytes" |
	"imageBytes" | "detailsBytes" | "upstreamTruncatedResults" | "overBudgetResults" |
	"potentialBytesOverBudget" | "enforcedResults" | "actualBytesSaved">;

type SafeObserveRun = {
	caseId: string;
	model: string;
	taskPassed: boolean;
	observationValid: boolean;
	expectedClass: ContextGatewayToolClass;
	elapsedMs: number;
	parentTokens: number;
	toolCallCount: number;
	mode: "observe" | "missing";
	maxResultBytes: number | null;
	budgetBytes: number | null;
	totals: SafeClassTelemetry | null;
	byClass: Partial<Record<ContextGatewayToolClass, SafeClassTelemetry>>;
};

const EXPECTED_CLASS_BY_CASE: Record<string, ContextGatewayToolClass> = {
	"observe.residual-large-read": "code-read",
	"observe.residual-large-bash": "shell",
	"observe.residual-large-ast-grep": "ast-grep",
};

function pickClassTelemetry(value: ContextGatewayClassTelemetry): SafeClassTelemetry {
	return {
		results: value.results,
		errors: value.errors,
		contentBytes: value.contentBytes,
		deliveredContentBytes: value.deliveredContentBytes,
		textBytes: value.textBytes,
		imageBytes: value.imageBytes,
		detailsBytes: value.detailsBytes,
		upstreamTruncatedResults: value.upstreamTruncatedResults,
		overBudgetResults: value.overBudgetResults,
		potentialBytesOverBudget: value.potentialBytesOverBudget,
		enforcedResults: value.enforcedResults,
		actualBytesSaved: value.actualBytesSaved,
	};
}

function expectedBudgetForClass(
	toolClass: ContextGatewayToolClass,
	budgets: ContextGatewayBudgets | undefined,
): number | null {
	if (!budgets) return null;
	if (toolClass === "code-read") return budgets.maxExactReadBytes;
	if (["repo-search", "repo-ast", "repo-structure", "ast-grep"].includes(toolClass)) {
		return budgets.maxSearchBytes;
	}
	return budgets.maxResultBytes;
}

function safeSnapshot(result: EvalRunResult, expectedClass: ContextGatewayToolClass): SafeObserveRun {
	const telemetry = result.metrics.contextGateway;
	const snapshot = telemetry?.snapshot;
	const byClass: SafeObserveRun["byClass"] = {};
	for (const [toolClass, counters] of Object.entries(snapshot?.byClass ?? {})) {
		if (counters) byClass[toolClass as ContextGatewayToolClass] = pickClassTelemetry(counters);
	}
	const expected = byClass[expectedClass];
	const budgetBytes = expectedBudgetForClass(expectedClass, telemetry?.budgets);
	const lastObservation = snapshot?.lastObservation;
	const expectedOverBudget = budgetBytes !== null && expected
		? expected.contentBytes > budgetBytes
		: false;
	const observationValid = telemetry?.mode === "observe"
		&& telemetry.maxResultBytes === OBSERVE_MAX_RESULT_BYTES
		&& lastObservation?.toolClass === expectedClass
		&& lastObservation.budgetBytes === budgetBytes
		&& expected?.results === 1
		&& expected.upstreamTruncatedResults === 1
		&& expected.overBudgetResults === (expectedOverBudget ? 1 : 0)
		&& expected.enforcedResults === 0
		&& expected.actualBytesSaved === 0;
	return {
		caseId: result.caseId,
		model: result.model,
		taskPassed: result.passed,
		observationValid,
		expectedClass,
		elapsedMs: result.metrics.elapsedMs,
		parentTokens: result.metrics.parentUsage.totalTokens,
		toolCallCount: result.metrics.toolCallCount,
		mode: telemetry?.mode ?? "missing",
		maxResultBytes: telemetry?.maxResultBytes ?? null,
		budgetBytes,
		totals: snapshot ? pickClassTelemetry(snapshot) : null,
		byClass,
	};
}

function addCounters(target: ContextGatewayClassTelemetry, source: SafeClassTelemetry): void {
	target.results += source.results;
	target.errors += source.errors;
	target.contentBytes += source.contentBytes;
	target.deliveredContentBytes += source.deliveredContentBytes;
	target.textBytes += source.textBytes;
	target.imageBytes += source.imageBytes;
	target.detailsBytes += source.detailsBytes;
	target.upstreamTruncatedResults += source.upstreamTruncatedResults;
	target.overBudgetResults += source.overBudgetResults;
	target.potentialBytesOverBudget += source.potentialBytesOverBudget;
	target.enforcedResults += source.enforcedResults;
	target.actualBytesSaved += source.actualBytesSaved;
}

function emptyCounters(): ContextGatewayClassTelemetry {
	return {
		results: 0,
		errors: 0,
		contentBytes: 0,
		deliveredContentBytes: 0,
		textBytes: 0,
		imageBytes: 0,
		detailsBytes: 0,
		upstreamTruncatedResults: 0,
		overBudgetResults: 0,
		potentialBytesOverBudget: 0,
		enforcedResults: 0,
		actualBytesSaved: 0,
	};
}

function aggregateByClass(runs: SafeObserveRun[]): Partial<Record<ContextGatewayToolClass, SafeClassTelemetry>> {
	const result: Partial<Record<ContextGatewayToolClass, ContextGatewayClassTelemetry>> = {};
	for (const run of runs) {
		for (const [toolClass, counters] of Object.entries(run.byClass)) {
			if (!counters) continue;
			const key = toolClass as ContextGatewayToolClass;
			const target = result[key] ?? emptyCounters();
			result[key] = target;
			addCounters(target, counters);
		}
	}
	return result;
}

function renderMarkdown(startedAt: string, finishedAt: string, runs: SafeObserveRun[], byClass: SafeObserveRun["byClass"]): string {
	const lines = [
		"# Context Gateway Observe Residual Evidence",
		"",
		`Started: ${startedAt}`,
		`Finished: ${finishedAt}`,
		"",
		"> Synthetic newly-created eval sessions only. Report contains aggregate ContextGatewayTelemetry counters; no tool arguments, result bodies, project paths, or archive references are included.",
		"",
		"| Case | Model | Task pass | Observation valid | Budget bytes | Calls | Tokens | Results | Upstream-truncated | Over class budget | Potential bytes over budget |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const run of runs) {
		lines.push(`| ${run.caseId} | ${run.model} | ${run.taskPassed ? "PASS" : "FAIL"} | ${run.observationValid ? "VALID" : "INVALID"} | ${run.budgetBytes ?? 0} | ${run.toolCallCount} | ${run.parentTokens} | ${run.totals?.results ?? 0} | ${run.totals?.upstreamTruncatedResults ?? 0} | ${run.totals?.overBudgetResults ?? 0} | ${run.totals?.potentialBytesOverBudget ?? 0} |`);
	}
	lines.push("", "## Aggregate by tool class", "", "| Class | Results | Upstream-truncated | Over class budget | Content bytes | Details bytes | Potential bytes over budget |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
	for (const [toolClass, counters] of Object.entries(byClass).sort(([a], [b]) => a.localeCompare(b))) {
		if (!counters) continue;
		lines.push(`| ${toolClass} | ${counters.results} | ${counters.upstreamTruncatedResults} | ${counters.overBudgetResults} | ${counters.contentBytes} | ${counters.detailsBytes} | ${counters.potentialBytesOverBudget} |`);
	}
	return lines.join("\n") + "\n";
}

const startedAt = new Date().toISOString();
const runs: SafeObserveRun[] = [];
for (const model of models) {
	for (const evalCase of OBSERVE_CASES) {
		process.stderr.write(`[context-gateway-observe] ${model} :: ${evalCase.id}\n`);
		const result = await runEvalCase(evalCase, model, {
			timeoutMs,
			streamIo,
			prepareProject: prepareResidualProject,
			env: {
				PI_CONTEXT_GATEWAY_MODE: "observe",
				PI_REPO_DISCOVERY_PROFILE: "native-compact",
			},
		});
		const expectedClass = EXPECTED_CLASS_BY_CASE[evalCase.id];
		if (!expectedClass) throw new Error(`Missing expected Context Gateway class for ${evalCase.id}`);
		const safe = safeSnapshot(result, expectedClass);
		runs.push(safe);
		process.stderr.write(`[context-gateway-observe] task=${safe.taskPassed ? "PASS" : "FAIL"} observation=${safe.observationValid ? "VALID" : "INVALID"} results=${safe.totals?.results ?? 0} overBudget=${safe.totals?.overBudgetResults ?? 0} upstreamTruncated=${safe.totals?.upstreamTruncatedResults ?? 0}\n`);
	}
}

const finishedAt = new Date().toISOString();
const byClass = aggregateByClass(runs);
const report = { version: 1, startedAt, finishedAt, models, budgetBytes: OBSERVE_MAX_RESULT_BYTES, runs, byClass };
const serialized = JSON.stringify(report, null, 2) + "\n";
for (const sentinel of BODY_SENTINELS) {
	if (serialized.includes(sentinel)) throw new Error("Context Gateway observe report leaked a synthetic result-body sentinel");
}

fs.mkdirSync(outputDir, { recursive: true });
const jsonPath = path.join(outputDir, "context-gateway-observe-report.json");
const markdownPath = path.join(outputDir, "context-gateway-observe-report.md");
fs.writeFileSync(jsonPath, serialized, "utf8");
fs.writeFileSync(markdownPath, renderMarkdown(startedAt, finishedAt, runs, byClass), "utf8");

console.log(`JSON: ${jsonPath}`);
console.log(`Markdown: ${markdownPath}`);
console.log(`Runs: ${runs.length}`);
if (runs.some((run) => !run.observationValid)) process.exitCode = 1;
