import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { HeadsUpContext, cleanObserverText } from "../../src/bundled-extensions/heads-up/context.js";
import { DEFAULT_HEADS_UP_CONFIG } from "../../src/bundled-extensions/heads-up/config.js";
import { parseHeadsUpResponse } from "../../src/bundled-extensions/heads-up/parser.js";
import { validObserverUsage } from "../../src/bundled-extensions/heads-up/usage.js";
import { DelegatedEvidence } from "../../src/bundled-extensions/heads-up/delegated.js";
import type { EvalCase } from "./cases.js";

export type Outcome = "tp" | "tn" | "fp" | "fn" | "wrong_notice" | "invalid" | "error" | "timeout" | "cancelled" | "not_run";
export interface CaseResult {
	caseId: string;
	iteration: number;
	expected: "heads_up" | "none";
	outcome: Outcome;
	issues: string[];
	inputChars: number;
	latencyMs: number | null;
	/** Only bounded visible text. No thinking, headers, credentials or raw provider errors. */
	response: string;
	stopReason?: string;
	servedModel?: string;
	usage?: Usage;
}

export function buildCaseInput(testCase: EvalCase) {
	const context = new HeadsUpContext();
	for (const entry of testCase.entries) context.addMessage(entry.message, entry.id);
	const delegated = new DelegatedEvidence();
	for (const event of testCase.delegatedEvents ?? []) delegated.accept(event, "eval-parent");
	for (const record of delegated.records(new Set(testCase.entries.map((entry) => entry.id)))) context.add(record);
	return context.toInput(DEFAULT_HEADS_UP_CONFIG.maxInputChars, testCase.previousNotices);
}

function normalize(text: string): string { return text.toLowerCase().replace(/ё/g, "е"); }

/** Quality checks are an intentionally transparent proxy; a human must read accepted notices. */
export function assess(testCase: EvalCase, message: AssistantMessage): Pick<CaseResult, "outcome" | "issues" | "response" | "servedModel" | "stopReason" | "usage"> {
	const input = buildCaseInput(testCase);
	const parsed = parseHeadsUpResponse(message, input.records, 0, DEFAULT_HEADS_UP_CONFIG.noticeTtlMs);
	const response = cleanObserverText(message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), 8000);
	const base = { response, servedModel: `${message.provider}/${message.model}`, stopReason: message.stopReason,
		...(validObserverUsage(message.usage) ? { usage: message.usage } : {}) };
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return { ...base, response: "", outcome: "error", issues: ["provider returned an error/aborted response (not a correct abstention)"] };
	}
	// The production controller refuses findings whose usage cannot be attributed.
	if (!validObserverUsage(message.usage) || !message.provider || !message.model) {
		return { ...base, outcome: "error", issues: ["missing attributable usage; production would refuse this result"] };
	}
	if (parsed.kind === "invalid") return { ...base, outcome: "invalid", issues: ["production parser rejected the response"] };
	if (parsed.kind === "none") return { ...base, outcome: testCase.expected.kind === "none" ? "tn" : "fn", issues: [] };
	if (testCase.expected.kind === "none") return { ...base, outcome: "fp", issues: [testCase.rationale] };
	const cited = new Set(parsed.notice.evidence.map((entry) => entry.id));
	const text = normalize(`${parsed.notice.title} ${parsed.notice.consequence}`);
	const issues: string[] = [];
	for (const group of testCase.expected.evidenceGroups) {
		if (!group.some((id) => cited.has(id))) issues.push(`missing supporting evidence: ${group.join(" or ")}`);
	}
	for (const group of testCase.expected.concepts) {
		if (!group.some((concept) => text.includes(normalize(concept)))) issues.push(`missing consequence anchor: ${group.join(" / ")}`);
	}
	return { ...base, outcome: issues.length ? "wrong_notice" : "tp", issues };
}

export function validateCases(cases: readonly EvalCase[]): void {
	if (!cases.length) throw new Error("No evaluation cases selected");
	const ids = new Set<string>();
	for (const testCase of cases) {
		if (!/^[a-z0-9-]+$/.test(testCase.id) || ids.has(testCase.id)) throw new Error(`Invalid or duplicate case: ${testCase.id}`);
		ids.add(testCase.id);
		const entryIds = new Set(testCase.entries.map((entry) => entry.id));
		if (entryIds.size !== testCase.entries.length) throw new Error(`Duplicate entry IDs in ${testCase.id}`);
		const input = buildCaseInput(testCase);
		if (input.body.length > DEFAULT_HEADS_UP_CONFIG.maxInputChars) throw new Error(`Input overflow: ${testCase.id}`);
		if (!input.records.some((record) => record.kind === "user") || !input.records.some((record) => record.kind !== "user")) throw new Error(`Missing user/work context: ${testCase.id}`);
		if (/EVAL_(?:SECRET|PRIVATE_THINKING|IMAGE)_CANARY/.test(input.body)) throw new Error(`Private canary escaped in ${testCase.id}`);
		if (testCase.expected.kind === "heads_up") {
			if (!testCase.expected.evidenceGroups.length || !testCase.expected.concepts.length) throw new Error(`Empty rubric: ${testCase.id}`);
			for (const group of testCase.expected.evidenceGroups) {
				if (!group.length || !group.some((id) => input.records.some((record) => record.id === id))) throw new Error(`Required evidence clipped out: ${testCase.id}`);
			}
			if (testCase.expected.concepts.some((group) => !group.length || group.some((text) => !text.trim()))) throw new Error(`Empty concept: ${testCase.id}`);
		}
	}
}

function ratio(numerator: number, denominator: number): number | null { return denominator ? numerator / denominator : null; }
function percentile(values: number[], percent: number): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * percent) - 1)]!;
}

export function summarize(results: readonly CaseResult[]) {
	const counts = Object.fromEntries(["tp", "tn", "fp", "fn", "wrong_notice", "invalid", "error", "timeout", "cancelled", "not_run"].map((kind) => [kind, results.filter((result) => result.outcome === kind).length])) as Record<Outcome, number>;
	const positives = results.filter((result) => result.expected === "heads_up").length;
	const negatives = results.length - positives;
	const attempted = results.length - counts.not_run;
	const usage = results.flatMap((result) => result.usage ? [result.usage] : []);
	const latencies = results.flatMap((result) => result.latencyMs === null ? [] : [result.latencyMs]);
	return {
		planned: results.length, attempted, positives, negatives, counts,
		passed: counts.tp + counts.tn,
		noticesForHumanReview: counts.tp + counts.fp + counts.wrong_notice,
		complete: counts.error + counts.timeout + counts.cancelled + counts.not_run === 0,
		precisionProxy: ratio(counts.tp, counts.tp + counts.fp + counts.wrong_notice),
		/** Conservative, end-to-end: errors and unrun positive cases do not become hits. */
		recall: ratio(counts.tp, positives),
		falsePositiveRate: ratio(counts.fp, negatives),
		correctSilenceRate: ratio(counts.tn, negatives),
		validResponseRate: ratio(counts.tp + counts.tn + counts.fp + counts.fn + counts.wrong_notice, attempted),
		latencyP50Ms: percentile(latencies, 0.5), latencyP95Ms: percentile(latencies, 0.95),
		inputChars: results.reduce((sum, result) => sum + (result.outcome === "not_run" ? 0 : result.inputChars), 0),
		usageCalls: usage.length, missingUsageCalls: attempted - usage.length,
		inputTokens: usage.reduce((sum, item) => sum + item.input + item.cacheRead + item.cacheWrite, 0),
		outputTokens: usage.reduce((sum, item) => sum + item.output, 0),
		reportedCostTotal: usage.reduce((sum, item) => sum + item.cost.total, 0),
	};
}
