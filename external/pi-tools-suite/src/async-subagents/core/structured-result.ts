import { readResultText } from "./state.js";
import { getLive, getRecord, updateRecord } from "./store.js";
import type { AgentState, StructuredFileReference, StructuredFinding, StructuredResult, StructuredRisk, StructuredSeverity } from "./types.js";

const DEFAULT_MAX_RESULT_BYTES = 100_000;
const STDERR_PREVIEW_CHARS = 500;

export interface BuildStructuredResultOptions {
	agentId: string;
	state: AgentState;
	subagentType?: string;
	model?: string;
	maxResultBytes?: number;
	/** Full result text (live final text, parent message, or child session answer). */
	resultText?: string;
	stderr?: string;
}

/** Build a StructuredResult from the agent state and its result/stderr text. */
export function buildStructuredResult(opts: BuildStructuredResultOptions): StructuredResult {
	const { agentId, state, subagentType, model, maxResultBytes, resultText, stderr } = opts;
	const maxBytes = maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
	const structured: StructuredResult = { schemaVersion: 2, agentId, status: state.status };
	if (state.exitCode !== undefined) structured.exitCode = state.exitCode;
	if (state.startedAt) structured.startedAt = state.startedAt;
	if (state.finishedAt) structured.finishedAt = state.finishedAt;
	if (state.startedAt && state.finishedAt) {
		const start = new Date(state.startedAt).getTime();
		const end = new Date(state.finishedAt).getTime();
		if (!isNaN(start) && !isNaN(end) && end >= start) structured.durationSeconds = Math.round((end - start) / 1000);
	}
	if (state.retryCount && state.retryCount > 0) structured.retryCount = state.retryCount;
	if (subagentType) structured.subagentType = subagentType;
	if (model) structured.model = model;
	if (resultText !== undefined) {
		const originalBytes = Buffer.byteLength(resultText, "utf-8");
		if (maxBytes > 0 && originalBytes > maxBytes) {
			structured.resultText = truncateToBytes(resultText, maxBytes);
			structured.resultTruncated = true;
			structured.resultOriginalBytes = originalBytes;
		} else {
			structured.resultText = resultText;
		}
		Object.assign(structured, extractStructuredFields(resultText));
	}
	const trimmedStderr = stderr?.trim();
	if (trimmedStderr) {
		structured.stderrPreview = trimmedStderr.length > STDERR_PREVIEW_CHARS
			? trimmedStderr.slice(0, STDERR_PREVIEW_CHARS) + "..."
			: trimmedStderr;
	}
	return structured;
}

/** Persisted form: everything except the (possibly large) result text. */
export function compactStructuredResult(structured: StructuredResult): StructuredResult {
	const { resultText: _resultText, ...compact } = structured;
	return compact;
}

export interface SettleStructuredResultOptions {
	state: AgentState;
	subagentType?: string;
	model?: string;
	maxResultBytes?: number;
}

/**
 * Compute the structured result of a settled agent and persist its compact
 * form (plus a bounded stderr preview) on the parent-session record.
 */
export function settleStructuredResult(runDir: string, agentId: string, opts: SettleStructuredResultOptions): StructuredResult {
	const record = getRecord(runDir, agentId);
	const live = getLive(runDir, agentId);
	const structured = buildStructuredResult({
		agentId,
		state: opts.state,
		subagentType: opts.subagentType ?? record?.subagentType ?? record?.task?.subagentType,
		model: opts.model ?? record?.model ?? record?.task?.model,
		maxResultBytes: opts.maxResultBytes ?? record?.maxResultBytes,
		resultText: readResultText(runDir, agentId),
		stderr: live?.stderrTail ?? record?.stderrPreview,
	});
	updateRecord(runDir, agentId, {
		structured: compactStructuredResult(structured),
		...(structured.stderrPreview ? { stderrPreview: structured.stderrPreview } : {}),
	});
	return structured;
}

function extractStructuredFields(text: string): Pick<StructuredResult, "summary" | "findings" | "files" | "risks" | "nextActions" | "confidence"> {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const result: Pick<StructuredResult, "summary" | "findings" | "files" | "risks" | "nextActions" | "confidence"> = {};
	const summary = firstSummaryLine(lines);
	if (summary) result.summary = trimMarkdownMarker(summary);
	const findings = extractFindings(lines);
	if (findings.length > 0) result.findings = findings;
	const files = extractFileReferences(text);
	if (files.length > 0) result.files = files;
	const risks = extractRisks(lines);
	if (risks.length > 0) result.risks = risks;
	const nextActions = extractNextActions(lines);
	if (nextActions.length > 0) result.nextActions = nextActions;
	const confidence = extractConfidence(text);
	if (confidence) result.confidence = confidence;
	return result;
}

function firstSummaryLine(lines: string[]): string | undefined {
	for (const line of lines) {
		const stripped = trimMarkdownMarker(line);
		if (!stripped || /^#{1,6}\s/.test(line)) continue;
		if (/^(summary|итог|вывод)\s*:?$/i.test(stripped)) continue;
		return stripped.length > 300 ? `${stripped.slice(0, 297)}...` : stripped;
	}
	return undefined;
}

function extractFindings(lines: string[]): StructuredFinding[] {
	const findings: StructuredFinding[] = [];
	for (const line of lines) {
		if (!/^([-*•]|\d+[.)])\s+/.test(line)) continue;
		const text = trimMarkdownMarker(line);
		if (!text) continue;
		const finding: StructuredFinding = { text: text.length > 500 ? `${text.slice(0, 497)}...` : text };
		const severity = extractSeverity(text);
		if (severity) finding.severity = severity;
		const file = extractFirstFileReference(text);
		if (file) Object.assign(finding, file);
		findings.push(finding);
		if (findings.length >= 20) break;
	}
	return findings;
}

function extractRisks(lines: string[]): StructuredRisk[] {
	const risks: StructuredRisk[] = [];
	for (const line of lines) {
		if (!/(risk|risky|danger|unsafe|security|vulnerab|ошиб|риск|опас|уязвим|критич)/i.test(line)) continue;
		const text = trimMarkdownMarker(line);
		if (!text) continue;
		const risk: StructuredRisk = { text: text.length > 500 ? `${text.slice(0, 497)}...` : text };
		const severity = extractSeverity(text);
		if (severity) risk.severity = severity;
		risks.push(risk);
		if (risks.length >= 10) break;
	}
	return risks;
}

function extractNextActions(lines: string[]): string[] {
	const actions: string[] = [];
	for (const line of lines) {
		if (!/(next|recommend|todo|fix|should|нужно|след|рекоменд|исправ|добав)/i.test(line)) continue;
		const text = trimMarkdownMarker(line);
		if (!text) continue;
		actions.push(text.length > 500 ? `${text.slice(0, 497)}...` : text);
		if (actions.length >= 10) break;
	}
	return actions;
}

function extractFileReferences(text: string): StructuredFileReference[] {
	const refs = new Map<string, StructuredFileReference>();
	const pattern = /(?:^|[\s`'"(])((?:[\w.-]+\/)+(?:[\w.-]+)(?::(\d+))?)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text))) {
		const rawPath = match[1];
		if (!/\.[A-Za-z0-9]+(?::\d+)?$/.test(rawPath)) continue;
		const filePath = rawPath.replace(/:\d+$/, "");
		const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
		const key = `${filePath}:${line ?? ""}`;
		if (!refs.has(key)) refs.set(key, line ? { path: filePath, line } : { path: filePath });
		if (refs.size >= 50) break;
	}
	return Array.from(refs.values());
}

function extractFirstFileReference(text: string): { file: string; line?: number } | undefined {
	const [first] = extractFileReferences(text);
	return first ? { file: first.path, line: first.line } : undefined;
}

function extractSeverity(text: string): StructuredSeverity | undefined {
	if (/\b(critical|blocker|urgent|критич|блокер)\b/i.test(text)) return "critical";
	if (/\b(high|major|высок)\b/i.test(text)) return "high";
	if (/\b(medium|moderate|средн)\b/i.test(text)) return "medium";
	if (/\b(low|minor|низк)\b/i.test(text)) return "low";
	return undefined;
}

function extractConfidence(text: string): "low" | "medium" | "high" | undefined {
	const match = /confidence\s*[:=-]\s*(low|medium|high)/i.exec(text);
	return match ? match[1].toLowerCase() as "low" | "medium" | "high" : undefined;
}

function trimMarkdownMarker(line: string): string {
	let stripped = line
		.replace(/^#{1,6}\s+/, "")
		.replace(/^([-*•]|\d+[.)])\s+/, "")
		.trim();
	const boldPrefix = /^\*\*(.*?)\*\*:?\s*(.*)$/.exec(stripped);
	if (boldPrefix) stripped = `${boldPrefix[1].replace(/:$/, "")}: ${boldPrefix[2]}`.trim();
	return stripped;
}

/**
 * Truncate a string so its UTF-8 byte length is at most maxBytes.
 */
function truncateToBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
	// Binary search for the right character count
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= maxBytes) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return text.slice(0, lo);
}
