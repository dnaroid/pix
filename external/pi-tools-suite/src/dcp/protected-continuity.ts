import { createHash } from "node:crypto";

import { planProspectiveTestOutputDelivery, parseTestBuildOutput } from "../context-gateway/test-output-parser.js";
import { classifyShellCommand, shellCommandText } from "../shell-command-policy.js";
import type { DcpConfig } from "./config.js";
import {
	isToolRecordPruningProtected,
	isToolRecordProtectedByFilePattern,
} from "./pruner-tools.js";
import type { ToolRecord } from "./state.js";

export type ToolContinuityMode = "none" | "digest" | "verbatim";

export interface ToolContinuityDecision {
	mode: ToolContinuityMode;
	text?: string;
	reason: string;
}

const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "exec", "execute"]);
const MAX_COMMAND_CHARS = 2_048;
const MAX_ERROR_EXCERPT_CHARS = 2_048;
const TEST_DIGEST_MAX_BYTES = 8_192;

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
	return `[command omitted: ${command.length} chars, sha256:${stableDigest(command)}]`;
}

function outputIdentity(output: string): string {
	return `${Buffer.byteLength(output, "utf8")} bytes, sha256:${stableDigest(output)}`;
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
		`Raw output identity: ${outputIdentity(output)}`,
	];
	if (body) lines.push(body);
	else if (record.isError) {
		const excerpt = boundedErrorExcerpt(output);
		if (excerpt) lines.push("Actionable error excerpt:", excerpt);
	}
	lines.push("Exact raw output is not retained in protected continuity; rerun the command only if exact text is needed.");
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
		return { mode: "verbatim", reason: `${reason}-not-smaller`, text: verbatim };
	}
	return { mode: "digest", reason, text: digest };
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
	if (!SHELL_TOOLS.has(normalized)) {
		return {
			mode: "verbatim",
			reason: "non-shell-protected-tool",
			text: verbatimToolText(record),
		};
	}
	if (isToolRecordProtectedByFilePattern(record, config)) {
		return {
			mode: "verbatim",
			reason: "protected-file-pattern",
			text: verbatimToolText(record),
		};
	}
	const gatewayCompact = gatewayCompactRepresentation(record);
	if (gatewayCompact) {
		return {
			mode: "verbatim",
			reason: "gateway-compacted",
			text: `### Tool: ${record.toolName}\n${gatewayCompact}`,
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
		return {
			mode: "verbatim",
			reason: `test-build-${compact.reason}`,
			text: verbatimToolText(record),
		};
	}

	return {
		mode: "verbatim",
		reason: classification.kind === "mutation"
			? "shell-mutation"
			: classification.scope === "compound"
				? "shell-compound"
				: "shell-unknown",
		text: verbatimToolText(record),
	};
}
