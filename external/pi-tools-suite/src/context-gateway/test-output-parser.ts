export type TestOutputClassification = "recognised" | "partial" | "unrecognised";
export type TestOutputFormat = "bun-test" | "tap" | "typescript" | "mixed" | "unknown";
export type TestOutputHostOutcome = "success" | "error";

export interface TestOutputDiagnostic {
	severity: "error" | "warning";
	/** Exact line from the parser's ANSI/CR-normalized text view. */
	text: string;
}

export interface TestOutputSummary {
	passed?: number;
	failed?: number;
	tests?: number;
	files?: number;
}

export interface ParsedTestBuildOutput {
	version: 1;
	classification: TestOutputClassification;
	format: TestOutputFormat;
	hostOutcome: TestOutputHostOutcome;
	upstreamTruncated: boolean;
	scanLimited: boolean;
	terminalSummarySeen: boolean;
	termination: "normal" | "timeout" | "abort";
	summary?: TestOutputSummary;
	diagnostics: TestOutputDiagnostic[];
	parserWarnings: Array<
		| "upstream-truncated"
		| "mixed-formats"
		| "host-outcome-conflict"
		| "failed-summary-without-diagnostic"
		| "nonterminal-summary"
		| "scan-limited"
	>;
}

export interface ProspectiveTestOutputDelivery {
	version: 1;
	decision: "compact-candidate" | "passthrough";
	reason:
		| "recognised-complete"
		| "parser-not-complete"
		| "upstream-truncated"
		| "termination-not-normal"
		| "compound-command"
		| "command-scope-unknown"
		| "compact-budget-exceeded";
	bytes: number;
	text?: string;
}

const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const DEFAULT_MAX_SCAN_CHARS = 1024 * 1024;

function boundedScanInput(text: string, maxScanChars: number): { text: string; limited: boolean } {
	if (text.length <= maxScanChars) return { text, limited: false };
	const half = Math.max(1, Math.floor(maxScanChars / 2));
	return {
		text: `${text.slice(0, half)}\n[context-gateway parser scan gap]\n${text.slice(-half)}`,
		limited: true,
	};
}

function normalizedTerminalLines(text: string): string[] {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			// A bare CR is normally a terminal overwrite. Parse the final visible
			// segment instead of concatenating stale progress text with the result.
			const visible = line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line;
			return visible.replace(ANSI_PATTERN, "");
		});
}

function nonBlank(lines: readonly string[]): string[] {
	return lines.filter((line) => line.trim().length > 0);
}

function parseCount(lines: readonly string[], pattern: RegExp): number | undefined {
	for (let index = lines.length - 1; index >= 0; index--) {
		const match = lines[index]!.match(pattern);
		if (!match) continue;
		const value = Number(match[1]);
		if (Number.isSafeInteger(value) && value >= 0) return value;
	}
	return undefined;
}

function lastIndexWhere(lines: readonly string[], predicate: (line: string) => boolean): number {
	for (let index = lines.length - 1; index >= 0; index--) {
		if (predicate(lines[index]!)) return index;
	}
	return -1;
}

function diagnosticLines(lines: readonly string[], patterns: Array<{ severity: "error" | "warning"; pattern: RegExp }>): TestOutputDiagnostic[] {
	const result: TestOutputDiagnostic[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		for (const entry of patterns) {
			if (!entry.pattern.test(line)) continue;
			const key = `${entry.severity}\u0000${line}`;
			if (!seen.has(key)) {
				seen.add(key);
				result.push({ severity: entry.severity, text: line });
			}
			break;
		}
	}
	return result;
}

function detectTermination(lines: readonly string[]): "normal" | "timeout" | "abort" {
	const tail = lines.slice(-8).join("\n");
	if (/Command timed out after \d+(?:\.\d+)? seconds/i.test(tail)) return "timeout";
	if (/Command aborted/i.test(tail)) return "abort";
	return "normal";
}

function isHostStatusLine(line: string): boolean {
	return /^Command exited with code \d+$/i.test(line.trim());
}

function nonHostTail(lines: readonly string[]): string[] {
	return nonBlank(lines).filter((line) => !isHostStatusLine(line) && !/^npm notice\b/.test(line.trim()));
}

function outcomeConflict(hostOutcome: TestOutputHostOutcome, failed: number | undefined): boolean {
	if (failed === undefined) return false;
	if (hostOutcome === "success") return failed > 0;
	return failed === 0;
}

function parseBun(lines: readonly string[], hostOutcome: TestOutputHostOutcome) {
	const hasBanner = lines.some((line) => /^bun test v\d+/i.test(line.trim()));
	const ranLineIndex = lastIndexWhere(lines, (line) => /^Ran \d+ tests? across \d+ files?\./.test(line.trim()));
	if (!hasBanner && ranLineIndex < 0) return undefined;
	const passed = parseCount(lines, /^\s*(\d+) pass\s*$/);
	const failed = parseCount(lines, /^\s*(\d+) fail\s*$/);
	const ran = ranLineIndex >= 0 ? lines[ranLineIndex]!.trim().match(/^Ran (\d+) tests? across (\d+) files?\./) : null;
	const tests = ran ? Number(ran[1]) : undefined;
	const files = ran ? Number(ran[2]) : undefined;
	const diagnostics = diagnosticLines(lines, [
		{ severity: "error", pattern: /^\s*\(fail\)\s+/ },
		{ severity: "error", pattern: /^\s*(?:error|Error):\s+/ },
		{ severity: "warning", pattern: /^\s*(?:warning|Warning):\s+/ },
	]);
	const tailAfterSummary = ranLineIndex >= 0 ? nonHostTail(lines.slice(ranLineIndex + 1)) : [];
	return {
		format: "bun-test" as const,
		terminalSummarySeen: passed !== undefined && failed !== undefined && tests !== undefined && files !== undefined,
		nonterminalSummary: tailAfterSummary.length > 0,
		summary: { passed, failed, tests, files },
		diagnostics,
		outcomeConflict: outcomeConflict(hostOutcome, failed),
		failedWithoutDiagnostic: (failed ?? 0) > 0 && diagnostics.length === 0,
	};
}

function parseTap(lines: readonly string[], hostOutcome: TestOutputHostOutcome) {
	const hasTap = lines.some((line) => /^TAP version \d+/.test(line.trim()))
		|| lines.some((line) => /^\s*(?:ok|not ok)\s+\d+\b/.test(line));
	if (!hasTap) return undefined;
	const tests = parseCount(lines, /^\s*#\s*tests\s+(\d+)\s*$/i);
	const passed = parseCount(lines, /^\s*#\s*pass\s+(\d+)\s*$/i);
	const failed = parseCount(lines, /^\s*#\s*fail\s+(\d+)\s*$/i);
	const planIndex = lastIndexWhere(lines, (line) => /^\s*1\.\.\d+\s*$/.test(line));
	const diagnostics = diagnosticLines(lines, [
		{ severity: "error", pattern: /^\s*not ok\s+\d+\b/ },
		{ severity: "error", pattern: /^\s*(?:error|message|operator):\s+/i },
		{ severity: "warning", pattern: /^\s*#\s*warning\b/i },
	]);
	const lastSummaryIndex = Math.max(
		planIndex,
		lastIndexWhere(lines, (line) => /^\s*#\s*(?:tests|pass|fail)\s+\d+\s*$/i.test(line)),
	);
	const tailAfterSummary = lastSummaryIndex >= 0 ? nonHostTail(lines.slice(lastSummaryIndex + 1)) : [];
	return {
		format: "tap" as const,
		terminalSummarySeen: planIndex >= 0 && tests !== undefined && passed !== undefined && failed !== undefined,
		nonterminalSummary: tailAfterSummary.length > 0,
		summary: { passed, failed, tests },
		diagnostics,
		outcomeConflict: outcomeConflict(hostOutcome, failed),
		failedWithoutDiagnostic: (failed ?? 0) > 0 && diagnostics.length === 0,
	};
}

const TSC_LOCATION = "(?:.+?\\(\\d+,\\d+\\):?|.+?:\\d+:\\d+\\s+-)";
const TSC_DIAGNOSTIC = new RegExp(`^${TSC_LOCATION}\\s*(error|warning)\\s+TS\\d+:\\s+.+$`, "i");

function parseTypescript(lines: readonly string[], hostOutcome: TestOutputHostOutcome) {
	const meaningful = nonBlank(lines);
	const diagnostics = diagnosticLines(meaningful, [
		{ severity: "error", pattern: new RegExp(`^${TSC_LOCATION}\\s*error\\s+TS\\d+:`, "i") },
		{ severity: "warning", pattern: new RegExp(`^${TSC_LOCATION}\\s*warning\\s+TS\\d+:`, "i") },
	]);
	const summaryPattern = /^Found \d+ errors?(?: in \d+ files?)?.*$/i;
	const summaryIndex = lastIndexWhere(meaningful, (line) => summaryPattern.test(line.trim()));
	if (diagnostics.length === 0 && summaryIndex < 0) return undefined;
	const summaryMatch = summaryIndex >= 0 ? meaningful[summaryIndex]!.trim().match(/^Found (\d+) errors?(?: in (\d+) files?)?/i) : null;
	const failed = summaryMatch ? Number(summaryMatch[1]) : diagnostics.filter((entry) => entry.severity === "error").length;
	const files = summaryMatch?.[2] ? Number(summaryMatch[2]) : undefined;
	const recognizedLines = meaningful.filter((line) => TSC_DIAGNOSTIC.test(line) || summaryPattern.test(line.trim()) || isHostStatusLine(line));
	const significantAfterSummary = summaryIndex >= 0 ? nonHostTail(meaningful.slice(summaryIndex + 1)) : [];
	return {
		format: "typescript" as const,
		terminalSummarySeen: summaryIndex >= 0 && significantAfterSummary.length === 0,
		nonterminalSummary: summaryIndex >= 0 && significantAfterSummary.length > 0,
		summary: { failed, files },
		diagnostics,
		outcomeConflict: outcomeConflict(hostOutcome, failed),
		failedWithoutDiagnostic: failed > 0 && diagnostics.length === 0,
		unparsedLines: meaningful.length - recognizedLines.length,
	};
}

export function parseTestBuildOutput(input: {
	text: string;
	hostOutcome: TestOutputHostOutcome;
	upstreamTruncated?: boolean;
	maxScanChars?: number;
}): ParsedTestBuildOutput {
	const maxScanChars = Number.isSafeInteger(input.maxScanChars) && (input.maxScanChars ?? 0) > 0
		? input.maxScanChars!
		: DEFAULT_MAX_SCAN_CHARS;
	const bounded = boundedScanInput(input.text, maxScanChars);
	const lines = normalizedTerminalLines(bounded.text);
	const termination = detectTermination(lines);
	const candidates = [
		parseBun(lines, input.hostOutcome),
		parseTap(lines, input.hostOutcome),
		parseTypescript(lines, input.hostOutcome),
	].filter((value): value is NonNullable<typeof value> => value !== undefined);

	const warnings: ParsedTestBuildOutput["parserWarnings"] = [];
	if (input.upstreamTruncated === true) warnings.push("upstream-truncated");
	if (bounded.limited) warnings.push("scan-limited");
	if (candidates.length > 1) warnings.push("mixed-formats");
	if (candidates.length === 0) {
		return {
			version: 1,
			classification: "unrecognised",
			format: "unknown",
			hostOutcome: input.hostOutcome,
			upstreamTruncated: input.upstreamTruncated === true,
			scanLimited: bounded.limited,
			terminalSummarySeen: false,
			termination,
			diagnostics: [],
			parserWarnings: warnings,
		};
	}

	const candidate = candidates[0]!;
	if (candidate.outcomeConflict) warnings.push("host-outcome-conflict");
	if (candidate.failedWithoutDiagnostic) warnings.push("failed-summary-without-diagnostic");
	if (candidate.nonterminalSummary) warnings.push("nonterminal-summary");
	const typescriptUnparsed = candidate.format === "typescript" ? candidate.unparsedLines : 0;
	const complete = candidates.length === 1
		&& input.upstreamTruncated !== true
		&& !bounded.limited
		&& termination === "normal"
		&& candidate.terminalSummarySeen
		&& !candidate.outcomeConflict
		&& !candidate.failedWithoutDiagnostic
		&& !candidate.nonterminalSummary
		&& typescriptUnparsed === 0;

	return {
		version: 1,
		classification: complete ? "recognised" : "partial",
		format: candidates.length > 1 ? "mixed" : candidate.format,
		hostOutcome: input.hostOutcome,
		upstreamTruncated: input.upstreamTruncated === true,
		scanLimited: bounded.limited,
		terminalSummarySeen: candidate.terminalSummarySeen,
		termination,
		summary: candidate.summary,
		diagnostics: candidate.diagnostics,
		parserWarnings: warnings,
	};
}

function summaryLine(parsed: ParsedTestBuildOutput): string | undefined {
	if (!parsed.summary) return undefined;
	const fields: string[] = [];
	if (parsed.summary.passed !== undefined) fields.push(`${parsed.summary.passed} passed`);
	if (parsed.summary.failed !== undefined) fields.push(`${parsed.summary.failed} failed`);
	if (parsed.summary.tests !== undefined) fields.push(`${parsed.summary.tests} tests`);
	if (parsed.summary.files !== undefined) fields.push(`${parsed.summary.files} files`);
	return fields.length > 0 ? fields.join(", ") : undefined;
}

export function planProspectiveTestOutputDelivery(
	parsed: ParsedTestBuildOutput,
	maxBytes: number,
	options: { commandScope?: "simple" | "compound" | "unknown" } = {},
): ProspectiveTestOutputDelivery {
	if (parsed.upstreamTruncated) return { version: 1, decision: "passthrough", reason: "upstream-truncated", bytes: 0 };
	if (parsed.termination !== "normal") return { version: 1, decision: "passthrough", reason: "termination-not-normal", bytes: 0 };
	if (parsed.classification !== "recognised") return { version: 1, decision: "passthrough", reason: "parser-not-complete", bytes: 0 };
	const commandScope = options.commandScope ?? "unknown";
	if (commandScope === "compound") return { version: 1, decision: "passthrough", reason: "compound-command", bytes: 0 };
	if (commandScope !== "simple") return { version: 1, decision: "passthrough", reason: "command-scope-unknown", bytes: 0 };

	const lines = [
		`Execution outcome: ${parsed.hostOutcome.toUpperCase()}`,
		`Recognised format: ${parsed.format}`,
	];
	const summary = summaryLine(parsed);
	if (summary) lines.push(`Terminal summary: ${summary}`);
	if (parsed.diagnostics.length > 0) {
		lines.push("Diagnostics:");
		for (const diagnostic of parsed.diagnostics) lines.push(diagnostic.text);
	}
	const text = lines.join("\n");
	const bytes = new TextEncoder().encode(text).byteLength;
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || bytes > maxBytes) {
		return { version: 1, decision: "passthrough", reason: "compact-budget-exceeded", bytes };
	}
	return { version: 1, decision: "compact-candidate", reason: "recognised-complete", bytes, text };
}
