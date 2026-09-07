import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import repoDiscoveryExtension from "../../src/repo-discovery/index.js";

type Arm = "baseline" | "prompt-compact" | "native-compact";

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: { cwd: string },
	) => Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
		details?: Record<string, any>;
	}>;
};

type Scenario = {
	id: string;
	toolName: "repo_search" | "repo_structure" | "repo_ast" | "repo_explain" | "repo_deps";
	initialParams: Record<string, unknown>;
	criticalFacts: string[];
	fakeIdx(args: string[]): string;
	nextParams?: (resultText: string, callIndex: number) => Record<string, unknown> | undefined;
};

type ArmResult = {
	arm: Arm;
	scenarioId: string;
	calls: number;
	refusals: number;
	fullOverrides: number;
	deliveredBytes: number;
	criticalFactsRecovered: number;
	criticalFactCoverage: number;
	continuationCalls: number;
	texts: string[];
};

const HISTORICAL_REPO_PROMPT_CHARS = 3_326;
const PROMPT_COMPACT_REPO_PROMPT_CHARS = 2_294;

function tempDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function firstText(result: Awaited<ReturnType<RegisteredTool["execute"]>>): string {
	return result.content.find((part) => part.type === "text")?.text ?? "";
}

function allFactsRecovered(texts: string[], facts: string[]): number {
	const corpus = texts.join("\n");
	return facts.filter((fact) => corpus.includes(fact)).length;
}

function searchFixture(args: string[]): string {
	const maxFilesIndex = args.indexOf("--max-files");
	const maxFiles = maxFilesIndex >= 0 ? Number(args[maxFilesIndex + 1]) : 3;
	const includeContent = args.includes("--include-content");
	const rows: string[] = [];
	for (let index = 0; index < Math.max(1, maxFiles); index++) {
		rows.push(`RESULT ${index + 1}: src/payments-${index + 1}.ts score=${(0.98 - index * 0.05).toFixed(2)}`);
		if (index === 0) rows.push("FACT_SEARCH_OWNER=src/payments-1.ts");
		if (includeContent && index === 0) {
			rows.push("export function createGatewayRequest(retryKey: string) {");
			rows.push("  const request = { retryKey, amount: 1000 }; // FACT_RETRY_KEY_REUSED");
			rows.push("  return request;");
			rows.push("}");
		}
		rows.push("metadata=" + "m".repeat(400));
	}
	return rows.join("\n");
}

function structureFixture(args: string[]): string {
	const cursorIndex = args.indexOf("--cursor");
	const cursor = cursorIndex >= 0 ? Number(args[cursorIndex + 1]) : 0;
	const maxFilesIndex = args.indexOf("--max-files");
	const maxFiles = maxFilesIndex >= 0 ? Number(args[maxFilesIndex + 1]) : 120;
	const rows: string[] = [];
	const end = Math.min(120, cursor + maxFiles);
	for (let index = cursor; index < end; index++) {
		rows.push(`src/module-${String(index).padStart(3, "0")}.ts`);
		rows.push(`  export symbol${index}() // ${"s".repeat(120)}`);
		if (index === 5) rows.push("FACT_STRUCTURE_PRIMARY=src/module-005.ts");
		if (index === 27) rows.push("FACT_STRUCTURE_LATE=src/module-027.ts");
	}
	if (end < 120) rows.push(`TRUNC cursor=${end}`);
	return rows.join("\n");
}

function astFixture(args: string[]): string {
	const cursorIndex = args.indexOf("--cursor");
	const cursor = cursorIndex >= 0 ? Number(args[cursorIndex + 1]) : 0;
	const maxNodesIndex = args.indexOf("--max-nodes");
	const maxNodes = maxNodesIndex >= 0 ? Number(args[maxNodesIndex + 1]) : 120;
	const rows: string[] = [];
	const end = Math.min(120, cursor + maxNodes);
	for (let index = cursor; index < end; index++) {
		rows.push(`node ${index}: CallExpression child=${index + 1} ${"a".repeat(100)}`);
		if (index === 8) rows.push("FACT_AST_ENTRY=retryRequest");
		if (index === 57) rows.push("FACT_AST_LATE=dedupeRetryKey");
	}
	if (end < 120) rows.push(`TRUNC cursor=${end}`);
	return rows.join("\n");
}

function explainFixture(args: string[]): string {
	if (args.includes("--signature-only")) {
		return [
			"symbol createGatewayRequest(retryKey: string): Request",
			"FACT_EXPLAIN_SIGNATURE=createGatewayRequest",
			"module src/payments.ts",
		].join("\n");
	}
	return [
		"symbol createGatewayRequest(retryKey: string): Request",
		"FACT_EXPLAIN_SIGNATURE=createGatewayRequest",
		...Array.from({ length: 120 }, (_, index) => `body ${index}: ${"b".repeat(200)}`),
	].join("\n");
}

function depsFixture(args: string[]): string {
	const depthIndex = args.indexOf("--depth");
	const depth = depthIndex >= 0 ? Number(args[depthIndex + 1]) : 1;
	return [
		"src/payments.ts -> src/gateway.ts",
		"FACT_DEPS_EDGE=payments->gateway",
		...Array.from({ length: depth * 60 }, (_, index) => `edge ${index}: module-${index} -> module-${index + 1} ${"d".repeat(100)}`),
	].join("\n");
}

const SCENARIOS: Scenario[] = [
	{
		id: "search-narrow-content-followup",
		toolName: "repo_search",
		initialParams: { target: "gateway retry request" },
		criticalFacts: ["FACT_SEARCH_OWNER=src/payments-1.ts", "FACT_RETRY_KEY_REUSED"],
		fakeIdx: searchFixture,
		nextParams(text, callIndex) {
			if (callIndex === 0 && !text.includes("FACT_RETRY_KEY_REUSED")) {
				return { target: "gateway retry request", args: ["--include-content", "--max-files", "1"] };
			}
			return undefined;
		},
	},
	{
		id: "structure-native-cursor",
		toolName: "repo_structure",
		initialParams: {},
		criticalFacts: ["FACT_STRUCTURE_PRIMARY=src/module-005.ts", "FACT_STRUCTURE_LATE=src/module-027.ts"],
		fakeIdx: structureFixture,
		nextParams(text, callIndex) {
			if (callIndex >= 4) return undefined;
			const match = /TRUNC cursor=(\d+)/.exec(text);
			return match ? { args: ["--cursor", match[1]!] } : undefined;
		},
	},
	{
		id: "ast-native-cursor",
		toolName: "repo_ast",
		initialParams: { target: "src/payments.ts" },
		criticalFacts: ["FACT_AST_ENTRY=retryRequest", "FACT_AST_LATE=dedupeRetryKey"],
		fakeIdx: astFixture,
		nextParams(text, callIndex) {
			if (callIndex >= 4) return undefined;
			const match = /TRUNC cursor=(\d+)/.exec(text);
			return match ? { target: "src/payments.ts", args: ["--cursor", match[1]!] } : undefined;
		},
	},
	{
		id: "explain-signature-first",
		toolName: "repo_explain",
		initialParams: { target: "createGatewayRequest" },
		criticalFacts: ["FACT_EXPLAIN_SIGNATURE=createGatewayRequest"],
		fakeIdx: explainFixture,
	},
	{
		id: "deps-shallow",
		toolName: "repo_deps",
		initialParams: { target: "src/payments.ts" },
		criticalFacts: ["FACT_DEPS_EDGE=payments->gateway"],
		fakeIdx: depsFixture,
	},
];

async function runScenario(arm: Arm, scenario: Scenario): Promise<ArmResult> {
	const projectRoot = tempDir(`context-gateway-benchmark-${arm}-`);
	mkdirSync(path.join(projectRoot, ".indexer-cli"));
	const tools = new Map<string, RegisteredTool>();
	let activeScenario = scenario;

	try {
		repoDiscoveryExtension({
			registerCommand: () => undefined,
			registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
			async exec(_command: string, args: string[]) {
				return { stdout: activeScenario.fakeIdx(args), stderr: "", code: 0 };
			},
		} as never, { profile: arm === "native-compact" ? "native-compact" : "baseline", cwd: projectRoot });

		const tool = tools.get(scenario.toolName);
		if (!tool) throw new Error(`missing tool ${scenario.toolName}`);
		const texts: string[] = [];
		let params: Record<string, unknown> | undefined = scenario.initialParams;
		let calls = 0;
		let refusals = 0;
		let fullOverrides = 0;
		let continuationCalls = 0;

		while (params && calls < 6) {
			const result = await tool.execute(`benchmark-${scenario.id}-${calls}`, params, undefined, undefined, { cwd: projectRoot });
			const text = firstText(result);
			texts.push(text);
			calls += 1;
			const nativePolicy = result.details?.nativePolicy as Record<string, unknown> | undefined;
			if (nativePolicy?.refused === true) refusals += 1;
			if (nativePolicy?.outputMode === "full") fullOverrides += 1;
			if (result.isError) break;

			const recovered = allFactsRecovered(texts, scenario.criticalFacts);
			if (recovered === scenario.criticalFacts.length) break;
			const next = scenario.nextParams?.(text, calls - 1);
			if (!next) break;
			continuationCalls += 1;
			params = next;
		}

		const recovered = allFactsRecovered(texts, scenario.criticalFacts);
		return {
			arm,
			scenarioId: scenario.id,
			calls,
			refusals,
			fullOverrides,
			deliveredBytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0),
			criticalFactsRecovered: recovered,
			criticalFactCoverage: recovered / scenario.criticalFacts.length,
			continuationCalls,
			texts,
		};
	} finally {
		rmSync(projectRoot, { recursive: true, force: true });
	}
}

function summarize(results: ArmResult[]) {
	return {
		calls: results.reduce((sum, result) => sum + result.calls, 0),
		refusals: results.reduce((sum, result) => sum + result.refusals, 0),
		fullOverrides: results.reduce((sum, result) => sum + result.fullOverrides, 0),
		deliveredBytes: results.reduce((sum, result) => sum + result.deliveredBytes, 0),
		continuationCalls: results.reduce((sum, result) => sum + result.continuationCalls, 0),
		criticalFactsRecovered: results.reduce((sum, result) => sum + result.criticalFactsRecovered, 0),
		criticalFactsTotal: results.reduce((sum, result) => sum + SCENARIOS.find((item) => item.id === result.scenarioId)!.criticalFacts.length, 0),
	};
}

async function runArm(arm: Arm): Promise<ArmResult[]> {
	const results: ArmResult[] = [];
	for (const scenario of SCENARIOS) results.push(await runScenario(arm, scenario));
	return results;
}

describe("P01-N offline paired runtime benchmark", () => {
	test("Prompt Compact is runtime-equivalent to Baseline while reducing registered repo guidance", async () => {
		const baseline = await runArm("baseline");
		const promptCompact = await runArm("prompt-compact");

		expect(promptCompact.map((result) => ({
			scenarioId: result.scenarioId,
			calls: result.calls,
			deliveredBytes: result.deliveredBytes,
			coverage: result.criticalFactCoverage,
		}))).toEqual(baseline.map((result) => ({
			scenarioId: result.scenarioId,
			calls: result.calls,
			deliveredBytes: result.deliveredBytes,
			coverage: result.criticalFactCoverage,
		})));
		expect(PROMPT_COMPACT_REPO_PROMPT_CHARS).toBeLessThan(HISTORICAL_REPO_PROMPT_CHARS);
		expect(HISTORICAL_REPO_PROMPT_CHARS - PROMPT_COMPACT_REPO_PROMPT_CHARS).toBe(1_032);
	});

	test("Native Compact reduces delivered bytes while deterministic continuations recover every critical fact", async () => {
		const baselineResults = await runArm("baseline");
		const nativeResults = await runArm("native-compact");
		const baseline = summarize(baselineResults);
		const native = summarize(nativeResults);
		if (process.env.PI_CONTEXT_GATEWAY_BENCHMARK_REPORT === "1") {
			console.log(JSON.stringify({
				promptChars: {
					baselineHistorical: HISTORICAL_REPO_PROMPT_CHARS,
					promptCompact: PROMPT_COMPACT_REPO_PROMPT_CHARS,
				},
				baseline,
				native,
				byteRatio: native.deliveredBytes / baseline.deliveredBytes,
				perScenario: { baseline: baselineResults, native: nativeResults },
			}, null, 2));
		}

		expect(baseline.criticalFactsRecovered).toBe(baseline.criticalFactsTotal);
		expect(native.criticalFactsRecovered).toBe(native.criticalFactsTotal);
		expect(native.refusals).toBe(0);
		expect(native.fullOverrides).toBe(0);
		expect(native.deliveredBytes).toBeLessThan(baseline.deliveredBytes);
		expect(native.deliveredBytes / baseline.deliveredBytes).toBeLessThan(0.55);
		expect(native.continuationCalls).toBeGreaterThanOrEqual(2);
		expect(native.calls).toBeGreaterThanOrEqual(baseline.calls);

		for (const result of nativeResults) {
			expect(result.criticalFactCoverage, result.scenarioId).toBe(1);
			expect(result.refusals, result.scenarioId).toBe(0);
		}
	});
});
