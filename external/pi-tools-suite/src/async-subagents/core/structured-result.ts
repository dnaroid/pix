import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentState, StructuredFileReference, StructuredFinding, StructuredResult, StructuredRisk, StructuredSeverity } from "./types.js";

const DEFAULT_MAX_RESULT_BYTES = 100_000;
const STDERR_PREVIEW_CHARS = 500;

export interface WriteStructuredResultOptions {
	agentDir: string;
	agentId: string;
	state: AgentState;
	subagentType?: string;
	model?: string;
	maxResultBytes?: number;
}

/**
 * Build a StructuredResult from the current agent state and files.
 * Reads result.md and stderr.log from agentDir.
 */
export function buildStructuredResult(opts: WriteStructuredResultOptions): StructuredResult {
	const { agentDir, agentId, state, subagentType, model, maxResultBytes } = opts;
	const maxBytes = maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;

	const structured: StructuredResult = {
		schemaVersion: 2,
		agentId,
		status: state.status,
	};

	if (state.exitCode !== undefined) structured.exitCode = state.exitCode;
	if (state.startedAt) structured.startedAt = state.startedAt;
	if (state.finishedAt) structured.finishedAt = state.finishedAt;

	// Compute duration
	if (state.startedAt && state.finishedAt) {
		const start = new Date(state.startedAt).getTime();
		const end = new Date(state.finishedAt).getTime();
		if (!isNaN(start) && !isNaN(end) && end >= start) {
			structured.durationSeconds = Math.round((end - start) / 1000);
		}
	}

	if (state.retryCount && state.retryCount > 0) structured.retryCount = state.retryCount;
	if (subagentType) structured.subagentType = subagentType;
	if (model) structured.model = model;

	// Read result.md
	const resultFile = path.join(agentDir, "result.md");
	if (fs.existsSync(resultFile)) {
		const fullText = fs.readFileSync(resultFile, "utf-8");
		const originalBytes = Buffer.byteLength(fullText, "utf-8");
		const structuredText = maxBytes > 0 && originalBytes > maxBytes
			? truncateToBytes(fullText, maxBytes)
			: fullText;
		if (maxBytes > 0 && originalBytes > maxBytes) {
			// Truncate result.json's resultText at a character boundary close to the byte limit.
			structured.resultText = structuredText;
			structured.resultTruncated = true;
			structured.resultOriginalBytes = originalBytes;
		} else {
			structured.resultText = structuredText;
		}
		Object.assign(structured, extractStructuredFields(fullText));
	}

	// Read stderr preview
	const stderrFile = path.join(agentDir, "stderr.log");
	if (fs.existsSync(stderrFile)) {
		const stderr = fs.readFileSync(stderrFile, "utf-8").trim();
		if (stderr) {
			structured.stderrPreview = stderr.length > STDERR_PREVIEW_CHARS
				? stderr.slice(0, STDERR_PREVIEW_CHARS) + "..."
				: stderr;
		}
	}

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
 * Write result.json to the agent directory.
 */
export function writeStructuredResult(opts: WriteStructuredResultOptions): StructuredResult {
	const structured = buildStructuredResult(opts);
	const jsonPath = path.join(opts.agentDir, "result.json");
	fs.writeFileSync(jsonPath, JSON.stringify(structured, null, 2), "utf-8");
	return structured;
}

/**
 * Read result.json from agent directory, if it exists.
 */
export function readStructuredResult(agentDir: string): StructuredResult | undefined {
	const jsonPath = path.join(agentDir, "result.json");
	if (!fs.existsSync(jsonPath)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as StructuredResult;
	} catch {
		return undefined;
	}
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
