import { createHash } from "node:crypto";

import { planProspectiveTestOutputDelivery, parseTestBuildOutput } from "../context-gateway/test-output-parser.js";
import { classifyShellCommand, shellCommandText } from "../shell-command-policy.js";
import type { DcpConfig } from "./config.js";
import {
	isToolRecordPruningProtected,
	isToolRecordProtectedByFilePattern,
} from "./pruner-tools.js";
import type { ToolRecord } from "./state.js";

export type ToolContinuityMode = "none" | "digest" | "receipt" | "verbatim";

export interface ToolContinuityDecision {
	mode: ToolContinuityMode;
	text?: string;
	reason: string;
	/** Stable identity of the raw delivered output represented by this decision. */
	sourceHash?: string;
	/** Raw delivered output size before continuity shaping. */
	sourceBytes?: number;
}

const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "exec", "execute"]);
const MUTATION_TOOLS = new Set(["apply_patch", "write", "edit", "ast_apply", "patch"]);
const MAX_COMMAND_CHARS = 2_048;
const MAX_ERROR_EXCERPT_CHARS = 2_048;
const MAX_MUTATION_SUMMARY_CHARS = 2_048;
const MAX_CHANGED_FILES = 40;
const TEST_DIGEST_MAX_BYTES = 8_192;
/** Unrecognised test/build output above this size gets a bounded receipt. */
const UNRECOGNISED_TEST_VERBATIM_MAX_BYTES = 4_096;

function normalizeToolName(name: string): string {
	return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function stableDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function renderedCommand(record: ToolRecord): string {
	const command = shellCommandText(record.inputArgs);
	if (!command) return "unavailable";
	if (command.length <= MAX_COMMAND_CHARS) return command;
	return `${command.slice(0, 240)}… [${command.length} chars total]`;
}

/**
 * Provider-visible size only. The content hash is kept in fragment metadata
 * (`sourceHash`) for identity; a 64-hex digest in the text is pure token noise.
 */
function outputSize(output: string): string {
	return `${Buffer.byteLength(output, "utf8")} bytes`;
}

function sourceMetadata(record: ToolRecord): Pick<ToolContinuityDecision, "sourceHash" | "sourceBytes"> {
	const output = record.outputText ?? "";
	return {
		sourceHash: stableDigest(output),
		sourceBytes: Buffer.byteLength(output, "utf8"),
	};
}

function boundedErrorExcerpt(output: string): string | undefined {
	const lines = output.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim().length > 0);
	const selected: string[] = [];
	const seen = new Set<string>();
	const add = (line: string) => {
		if (seen.has(line)) return;
		seen.add(line);
		selected.push(line);
	};
	for (const line of lines) {
		if (/\b(error|failed?|failure|exception|denied|not found|cannot|unable)\b/i.test(line)) add(line);
	}
	for (const line of lines.slice(-6)) add(line);
	if (selected.length === 0) return undefined;
	let text = selected.join("\n");
	if (text.length > MAX_ERROR_EXCERPT_CHARS) text = text.slice(0, MAX_ERROR_EXCERPT_CHARS) + "\n[excerpt truncated]";
	return text;
}

function shellDigest(record: ToolRecord, kind: "inspection" | "test-build", body?: string): string {
	const output = record.outputText ?? "";
	const lines = [
		`### Tool continuity: ${record.toolName}`,
		`Command: ${renderedCommand(record)}`,
		`Classification: ${kind}`,
		`Outcome: ${record.isError ? "error" : "success"}`,
		`Raw output size: ${outputSize(output)}`,
	];
	if (body) lines.push(body);
	else if (record.isError) {
		const excerpt = boundedErrorExcerpt(output);
		if (excerpt) lines.push("Actionable error excerpt:", excerpt);
	}
	lines.push("Exact raw output is not retained in protected continuity; rerun the command only if exact text is needed.");
	return lines.join("\n");
}

function shellReceipt(record: ToolRecord): string {
	const output = record.outputText ?? "";
	const classification = classifyShellCommand(record.inputArgs);
	const lines = [
		`### Tool continuity receipt: ${record.toolName}`,
		`Command: ${renderedCommand(record)}`,
		`Classification: ${classification.kind}/${classification.scope}`,
		`Outcome: ${record.isError ? "error" : "success"}`,
		`Raw output size: ${outputSize(output)}`,
	];
	const excerpt = boundedErrorExcerpt(output);
	if (excerpt) lines.push(record.isError ? "Actionable error excerpt:" : "Bounded output evidence:", excerpt);
	lines.push("Exact raw output remains in session history and is omitted from live protected continuity.");
	return lines.join("\n");
}

function recordDetails(record: ToolRecord): Record<string, unknown> | undefined {
	const details = record.outputDetails;
	return details && typeof details === "object" && !Array.isArray(details)
		? details as Record<string, unknown>
		: undefined;
}

function boundedChangedFiles(details: Record<string, unknown> | undefined): string[] {
	const changedFiles = details?.changedFiles;
	if (!Array.isArray(changedFiles)) return [];
	return changedFiles
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.slice(0, MAX_CHANGED_FILES);
}

function mutationReceipt(record: ToolRecord): string {
	const output = record.outputText ?? "";
	const details = recordDetails(record);
	const changedFiles = boundedChangedFiles(details);
	const rawSummary = typeof details?.summary === "string" ? details.summary.trim() : "";
	const summary = rawSummary.length > MAX_MUTATION_SUMMARY_CHARS
		? rawSummary.slice(0, MAX_MUTATION_SUMMARY_CHARS) + "\n[summary truncated]"
		: rawSummary;
	const lines = [
		`### Mutation continuity receipt: ${record.toolName}`,
		`Outcome: ${record.isError ? "error" : "success"}`,
	];
	if (changedFiles.length > 0) {
		lines.push(`Changed files (${changedFiles.length}${Array.isArray(details?.changedFiles) && details.changedFiles.length > changedFiles.length ? "+" : ""}):`);
		lines.push(...changedFiles.map((file) => `- ${file}`));
	}
	if (summary) lines.push("Producer summary:", summary);
	const excerpt = boundedErrorExcerpt(output);
	if (record.isError && excerpt) lines.push("Actionable error excerpt:", excerpt);
	lines.push(`Raw output size: ${outputSize(output)}`);
	lines.push("Exact raw output remains in session history and is omitted from live protected continuity.");
	return lines.join("\n");
}

function verbatimToolText(record: ToolRecord): string | undefined {
	const output = (record.outputText ?? "").trim();
	return output ? `### Tool: ${record.toolName}\n${output}` : undefined;
}

function preferSmallerDigest(
	record: ToolRecord,
	reason: string,
	digest: string,
): ToolContinuityDecision {
	const verbatim = verbatimToolText(record);
	if (verbatim && digest.length >= verbatim.length) {
		return { mode: "verbatim", reason: `${reason}-not-smaller`, text: verbatim, ...sourceMetadata(record) };
	}
	return { mode: "digest", reason, text: digest, ...sourceMetadata(record) };
}

function preferSmallerReceipt(
	record: ToolRecord,
	reason: string,
	receipt: string,
): ToolContinuityDecision {
	const verbatim = verbatimToolText(record);
	if (verbatim && receipt.length >= verbatim.length) {
		return { mode: "verbatim", reason: `${reason}-not-smaller`, text: verbatim, ...sourceMetadata(record) };
	}
	return { mode: "receipt", reason, text: receipt, ...sourceMetadata(record) };
}

function gatewayCompactRepresentation(record: ToolRecord): string | undefined {
	const details = record.outputDetails;
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const marker = (details as Record<string, unknown>).contextGateway;
	if (!marker || typeof marker !== "object" || Array.isArray(marker)) return undefined;
	const value = marker as Record<string, unknown>;
	if (value.version !== 1 || value.representation !== "test-build-compact") return undefined;
	return record.outputText?.trim() || undefined;
}

/**
 * Decide how much of a pruning-protected tool result must survive a compression
 * roll-up. Pruning safety and continuity retention are deliberately separate:
 * shell results remain protected from generic pruning, while proven read-only
 * inspection and confidently parsed test/build output can keep only a bounded
 * continuation digest.
 */
export function toolRecordContinuity(record: ToolRecord, config: DcpConfig): ToolContinuityDecision {
	if (!isToolRecordPruningProtected(record, config)) return { mode: "none", reason: "not-pruning-protected" };
	const normalized = normalizeToolName(record.toolName);
	const output = record.outputText ?? "";
	if (isToolRecordProtectedByFilePattern(record, config)) {
		return {
			mode: "verbatim",
			reason: "protected-file-pattern",
			text: verbatimToolText(record),
			...sourceMetadata(record),
		};
	}
	if (MUTATION_TOOLS.has(normalized)) {
		return preferSmallerReceipt(record, "mutation-receipt", mutationReceipt(record));
	}
	if (!SHELL_TOOLS.has(normalized)) {
		return {
			mode: "verbatim",
			reason: "non-shell-protected-tool",
			text: verbatimToolText(record),
			...sourceMetadata(record),
		};
	}
	const gatewayCompact = gatewayCompactRepresentation(record);
	if (gatewayCompact) {
		return {
			mode: "verbatim",
			reason: "gateway-compacted",
			text: `### Tool: ${record.toolName}\n${gatewayCompact}`,
			...sourceMetadata(record),
		};
	}

	const classification = classifyShellCommand(record.inputArgs);
	if (classification.kind === "inspection") {
		return preferSmallerDigest(record, "read-only-inspection", shellDigest(record, "inspection"));
	}
	if (classification.kind === "test-build" && classification.scope === "simple") {
		const parsed = parseTestBuildOutput({
			text: output,
			hostOutcome: record.isError ? "error" : "success",
		});
		const compact = planProspectiveTestOutputDelivery(parsed, TEST_DIGEST_MAX_BYTES, { commandScope: "simple" });
		if (compact.decision === "compact-candidate" && compact.text) {
			return preferSmallerDigest(
				record,
				"recognised-test-build",
				shellDigest(record, "test-build", compact.text),
			);
		}
		// Small unparsed output stays exact. Large unparsed output would otherwise
		// ride every roll-up verbatim (and can exceed the block budget, failing
		// compression closed); keep a bounded failure/tail receipt instead.
		if (Buffer.byteLength(output, "utf8") > UNRECOGNISED_TEST_VERBATIM_MAX_BYTES) {
			return preferSmallerReceipt(record, `test-build-${compact.reason}-receipt`, shellReceipt(record));
		}
		return {
			mode: "verbatim",
			reason: `test-build-${compact.reason}`,
			text: verbatimToolText(record),
			...sourceMetadata(record),
		};
	}

	return preferSmallerReceipt(
		record,
		classification.kind === "mutation"
			? "shell-mutation-receipt"
			: classification.scope === "compound"
				? "shell-compound-receipt"
				: "shell-unknown-receipt",
		shellReceipt(record),
	);
}
