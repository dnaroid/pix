import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EvalCase } from "./cases.js";
import { assess, buildCaseInput, summarize, validateCases, type CaseResult } from "./scoring.js";

export interface EvalRunOptions {
	cases: readonly EvalCase[];
	repeat: number;
	timeoutMs: number;
	signal?: AbortSignal;
	infer: (input: string, signal: AbortSignal) => Promise<AssistantMessage>;
	onResult?: (result: CaseResult) => void;
}

/** Sequential and bounded. A transport failure/timeout stops further calls, including ignored aborts. */
export async function runCases(options: EvalRunOptions): Promise<CaseResult[]> {
	validateCases(options.cases);
	if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 5
		|| !Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000) throw new Error("Invalid runner limits");
	const results: CaseResult[] = [];
	let stopped = false;
	for (let iteration = 1; iteration <= options.repeat; iteration++) {
		for (const testCase of options.cases) {
			const input = buildCaseInput(testCase);
			const base: CaseResult = { caseId: testCase.id, iteration, expected: testCase.expected.kind, outcome: "not_run", issues: [], response: "", inputChars: input.body.length, latencyMs: null };
			if (stopped || options.signal?.aborted) {
				const result = { ...base, issues: ["run stopped before this request"] };
				results.push(result); options.onResult?.(result); continue;
			}
			const abort = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let cancel = () => {};
			const started = performance.now();
			try {
				const interrupted = new Promise<{ outcome: "timeout" | "cancelled" }>((resolve) => {
					cancel = () => { resolve({ outcome: "cancelled" }); abort.abort(); };
					options.signal?.addEventListener("abort", cancel, { once: true });
					timer = setTimeout(() => { resolve({ outcome: "timeout" }); abort.abort(); }, options.timeoutMs);
					if (options.signal?.aborted) cancel();
				});
				// Convert rejection to data immediately; a late rejecting transport cannot become unhandled.
				const transport = Promise.resolve().then(() => {
					if (abort.signal.aborted) throw new Error("cancelled");
					return options.infer(input.body, abort.signal);
				}).then((message) => ({ message }), () => ({ outcome: "error" as const }));
				const resolved = await Promise.race([transport, interrupted]);
				const result: CaseResult = { ...base, latencyMs: Math.round(performance.now() - started),
					...("message" in resolved ? assess(testCase, resolved.message) : { outcome: resolved.outcome, issues: ["transport did not return a usable response; raw provider errors are not saved"] }) };
				stopped = ["error", "timeout", "cancelled"].includes(result.outcome);
				results.push(result); options.onResult?.(result);
			} finally {
				clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
			}
		}
	}
	return results;
}

export interface ModelReport { model: string; results: CaseResult[]; preflightError?: string; }

function percent(value: number | null): string { return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`; }
function cell(value: string): string { return value.replace(/[|\r\n]/g, " "); }

export function markdownReport(models: readonly ModelReport[], cases: readonly EvalCase[]): string {
	const lines = ["# Heads up live evaluation", "",
		"Synthetic development fixtures, not a held-out benchmark. No model judge. Positive scoring uses source IDs plus lexical consequence anchors; manually inspect the actual notices, including passes.",
		"Errors/invalid JSON are not correct silence. Recall includes all planned positives. Precision is n/a when no notices are emitted. Read false-positive rate only alongside coverage and correct-silence rate.",
		"Token/cost numbers are provider-reported. Zero reported cost is not evidence that a subscription request is free; missing usage is not reconstructed.", "",
		"| Model | Pass / planned | Precision proxy | Recall | False positives | Correct silence | Invalid | Errors / unrun | p50 / p95 ms | Input+cache / output tokens |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
	for (const model of models) {
		const s = summarize(model.results);
		lines.push(`| ${cell(model.model)} | ${s.passed}/${s.planned} | ${percent(s.precisionProxy)} | ${percent(s.recall)} | ${s.counts.fp}/${s.negatives} | ${percent(s.correctSilenceRate)} | ${s.counts.invalid} | ${s.counts.error + s.counts.timeout + s.counts.cancelled}/${s.counts.not_run} | ${s.latencyP50Ms ?? "n/a"}/${s.latencyP95Ms ?? "n/a"} | ${s.inputTokens}/${s.outputTokens} |`);
	}
	for (const model of models) {
		lines.push("", `## ${cell(model.model)}`, "");
		if (model.preflightError) lines.push(model.preflightError, "");
		for (const result of model.results) {
			lines.push(`### ${result.caseId} / ${result.iteration}: ${result.outcome}`, "",
				`Expected: ${result.expected}. ${cases.find((item) => item.id === result.caseId)?.rationale ?? ""}`, "",
				`Served: ${result.servedModel ?? "unknown"}; stop: ${result.stopReason ?? "unknown"}; latency: ${result.latencyMs ?? "n/a"} ms; usage: ${result.usage ? "reported" : "missing"}.`, "");
			if (result.issues.length) lines.push(result.issues.join("; "), "");
			// Blockquotes avoid a model-generated fence escaping a code block.
			if (result.response) lines.push(...result.response.split("\n").map((line) => `> ${line}`), "");
		}
	}
	return lines.join("\n");
}
