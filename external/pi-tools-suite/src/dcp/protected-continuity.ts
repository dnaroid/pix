import { createHash } from "node:crypto";
import { parseTestBuildOutput } from "./test-output-parser.js";
import { classifyShellCommand, shellCommandText } from "../shell-command-policy.js";
import type { DcpConfig } from "./config.js";
import { isToolRecordVerbatimProtected } from "./pruner-tools.js";
import type { ToolRecord } from "./state.js";
import { MUTATION_TOOLS, SHELL_TOOLS, normalizeContinuityToolName, toolNeedsContinuity } from "./tool-retention-policy.js";
import { boundedText, changedFiles, errorEvidence, evidenceReferences, failureDiagnostics, recordDetails } from "./continuity-evidence.js";

export type ToolContinuityMode = "none" | "digest" | "receipt" | "verbatim";
export interface ToolContinuityDecision {
	mode: ToolContinuityMode;
	text?: string;
	/** Irreducible action facts; never replaced by an anonymous count aggregate. */
	minimumText?: string;
	reason: string;
	sourceHash: string;
	sourceBytes: number;
}

function sourceMetadata(record: ToolRecord): Pick<ToolContinuityDecision, "sourceHash" | "sourceBytes"> {
	const output = record.outputText ?? "";
	return { sourceHash: createHash("sha256").update(output).digest("hex"), sourceBytes: Buffer.byteLength(output, "utf8") };
}

/** Exact retention is opt-in. A short result is not implicitly an exact pin. */
export function toolRecordContinuity(record: ToolRecord, config: DcpConfig): ToolContinuityDecision {
	const metadata = sourceMetadata(record);
	const name = normalizeContinuityToolName(record.toolName);
	const output = record.outputText ?? "";
	if (name === "compress") return { mode: "none", reason: "runtime-owned-state", ...metadata };
	if (isToolRecordVerbatimProtected(record, config)) {
		return { mode: "verbatim", reason: "explicit-verbatim", text: output ? `### Tool: ${record.toolName}\n${output}` : undefined, ...metadata };
	}
	if (!toolNeedsContinuity(record)) return { mode: "none", reason: "ordinary-observation", ...metadata };

	const shell = SHELL_TOOLS.has(name);
	const mutation = MUTATION_TOOLS.has(name);
	const classification = shell ? classifyShellCommand(record.inputArgs) : undefined;
	const test = classification?.kind === "test-build" && classification.scope === "simple";
	const details = recordDetails(record);
	// Tool success is not proof of a remote effect's success. A timeout/error may
	// have occurred after the side effect. Persist UNKNOWN rather than invite retry.
	const outcome = record.outputText === undefined ? "UNKNOWN; result not observed" : record.isError ? "error; effect UNKNOWN" : mutation ? "success" : "delivered; effect UNKNOWN";
	const facts = [
		`### ${mutation ? "Mutation continuity receipt" : "Tool continuity receipt"}: ${record.toolName}`,
		`Source: tool:${record.toolCallId} @${record.timestamp} (raw session).`,
		`Outcome: ${outcome}`,
	];
	if (shell) facts.push(`Command: ${boundedText(shellCommandText(record.inputArgs) || "UNKNOWN", 512)}`);
	else if (typeof record.inputArgs.action === "string" || typeof record.inputArgs.op === "string") {
		facts.push(`Action: ${record.inputArgs.action ?? record.inputArgs.op}`);
	}
	if (mutation) {
		const paths = changedFiles(record);
		facts.push(`Changed/attempted paths: ${paths.length ? paths.join(", ") : "UNKNOWN; recover source"}`);
	}
	const refs = evidenceReferences(record);
	if (refs.length) facts.push(`Evidence: ${refs.join("; ")}`);
	if (test) facts.push("Historical test/build; code version UNKNOWN unless recorded. Not current verification.");
	if (!mutation && !test) facts.push("Do not repeat blindly; recover source/status first.");
	if (record.isError && !test) facts.push(`Unresolved failure: ${errorEvidence(output) ?? "UNKNOWN; recover source"}`);
	else if (mutation && failureDiagnostics(output)) facts.push(`Reported diagnostics: ${failureDiagnostics(output)}`);
	const extra: string[] = [];
	if (classification) extra.push(`Classification: ${classification.kind}/${classification.scope}`);
	if (typeof details.summary === "string") extra.push(`Producer summary: ${boundedText(details.summary)}`);
	if (test) {
		const parsed = parseTestBuildOutput({ text: output, hostOutcome: record.isError ? "error" : "success" });
		// Keep the outcome and an actionable bounded diagnostic, not the entire
		// (up to 8 KiB) compact log, in every historical record's safety floor.
		facts.push(`Execution outcome: ${parsed.hostOutcome.toUpperCase()}; termination: ${parsed.termination}; parser: ${parsed.classification}`);
		const counts = parsed.summary;
		if (counts) facts.push(`Observed counts: ${[
			counts.passed === undefined ? undefined : `${counts.passed} passed`,
			counts.failed === undefined ? undefined : `${counts.failed} failed`,
			counts.tests === undefined ? undefined : `${counts.tests} tests`,
			counts.files === undefined ? undefined : `${counts.files} files`,
		].filter(Boolean).join(", ")}`);
		if (parsed.parserWarnings.length) facts.push(`Parser caveats: ${parsed.parserWarnings.join(", ")}`);
		const diagnostics = parsed.diagnostics.map((diagnostic) => diagnostic.text).join("\n");
		if (diagnostics || record.isError || parsed.classification !== "recognised") {
			const actionable = parsed.diagnostics.slice(0, 2).map((diagnostic) => diagnostic.text).join("\n");
			facts.push(`Diagnostic evidence: ${boundedText(actionable || errorEvidence(output) || "UNKNOWN; recover source", 768)}`);
			if (parsed.diagnostics.length > 2) facts.push(`${parsed.diagnostics.length - 2} additional diagnostics omitted; recover source before acting.`);
		}
	} else if (!record.isError && !mutation) {
		const evidence = errorEvidence(output);
		if (evidence) extra.push(`Bounded output evidence: ${evidence}`);
	}
	return {
		mode: test ? "digest" : "receipt",
		reason: test ? "historical-test-build" : mutation ? "mutation-receipt" : "action-receipt",
		text: [...facts, ...extra].join("\n"),
		minimumText: facts.join("\n"),
		...metadata,
	};
}

/** Only inspections are repeatable observations; identical test commands may
 * cover different code revisions and must not supersede historical evidence. */
export function repeatableObservationKey(record: ToolRecord, config: DcpConfig): string | undefined {
	return !isToolRecordVerbatimProtected(record, config) &&
		SHELL_TOOLS.has(normalizeContinuityToolName(record.toolName)) &&
		classifyShellCommand(record.inputArgs).kind === "inspection"
		? record.inputFingerprint : undefined;
}
