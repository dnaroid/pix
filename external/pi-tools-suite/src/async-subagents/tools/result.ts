import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { ASYNC_SUBAGENT_TOOL_DESCRIPTIONS } from "../../tool-descriptions.js";
import { readResult, validateBasename } from "../lib.js";
import { resolveSubagentAgentRunDir } from "../core/lookup.js";
import { getRecord } from "../core/store.js";
import type { AgentResult } from "../lib.js";
import type { StructuredFileReference, StructuredFinding, StructuredRisk } from "../core/types.js";
import { INLINE_RENDERING } from "../constants.js";
import { truncate } from "../format.js";
import { emptyToolSlot } from "../ui.js";

const MAX_COMPACT_FINDINGS = 10;
const MAX_COMPACT_FILES = 20;
const MAX_COMPACT_RISKS = 10;
const MAX_COMPACT_NEXT_ACTIONS = 10;

/** Bound of the result text inlined into the parent context. */
const MAX_INLINE_RESULT_CHARS = 12_000;
const MAX_INLINE_STDERR_CHARS = 2_000;

export function registerResultTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...ASYNC_SUBAGENT_TOOL_DESCRIPTIONS.resultAction,
		...INLINE_RENDERING,
		parameters: Type.Object({
			runDir: Type.Optional(Type.String({ description: "Batch name (or run key). If omitted, resolves agentId to its latest run in this session." })),
			agentId: Type.String({ description: "Agent ID to read" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			validateBasename(params.agentId, "agentId");
			const runDir = resolveSubagentAgentRunDir(ctx, params.agentId, params.runDir);
			const result = readResult(runDir, params.agentId, { includeRawFiles: true });

			if (!result) {
				return {
					content: [{ type: "text", text: `Agent "${params.agentId}" not found in ${runDir}` }],
					details: { runDir, agentId: params.agentId },
					isError: true,
				};
			}

			const parts: string[] = [];
			parts.push(`Agent: ${params.agentId}`);
			parts.push(`Status: ${result.state.status}`);
			if (result.exitCode !== undefined) parts.push(`Exit code: ${result.exitCode}`);
			if (result.state.retryCount) parts.push(`Retries: ${result.state.retryCount}`);

			if (result.state.status === "running") {
				parts.push("\nAgent is still running. Wait for it to finish, then read the result again.");
			}

			// Include structured metadata when available
			if (result.structured) {
				const s = result.structured;
				if (s.durationSeconds !== undefined) parts.push(`Duration: ${s.durationSeconds}s`);
				if (s.subagentType) parts.push(`Type: ${s.subagentType}`);
				if (s.model) parts.push(`Model: ${s.model}`);
				if (s.resultTruncated) parts.push(`Result truncated: ${s.resultOriginalBytes} bytes → maxResultBytes`);
			}

			appendCompactResult(parts, result);
			const childSessionFile = getRecord(runDir, params.agentId)?.childSessionFile;

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: {
					runDir,
					agentId: params.agentId,
					state: result.state,
					exitCode: result.exitCode,
					structured: compactStructuredForDetails(result.structured),
					...(childSessionFile ? { childSessionFile } : {}),
				},
			};
		},

		renderCall() {
			return emptyToolSlot();
		},

		renderResult() {
			// Result reads should enrich the assistant's answer, not add one mini-block per agent.
			return emptyToolSlot();
		},
	});
}

function appendCompactResult(parts: string[], result: AgentResult): void {
	const structured = result.structured;
	if (structured?.confidence) parts.push(`Confidence: ${structured.confidence}`);
	if (structured?.findings?.length) appendList(parts, "Findings", structured.findings, formatFinding, MAX_COMPACT_FINDINGS);
	if (structured?.files?.length) appendList(parts, "Referenced files", structured.files, formatFileReference, MAX_COMPACT_FILES);
	if (structured?.risks?.length) appendList(parts, "Risks", structured.risks, formatRisk, MAX_COMPACT_RISKS);
	if (structured?.nextActions?.length) appendList(parts, "Next actions", structured.nextActions, (action) => truncate(action, 500), MAX_COMPACT_NEXT_ACTIONS);

	const text = result.result?.trim();
	if (text) {
		const clipped = text.length > MAX_INLINE_RESULT_CHARS;
		parts.push(`\n--- Result${clipped ? ` (first ${MAX_INLINE_RESULT_CHARS} of ${text.length} chars; the full answer is the child session's last message)` : ""} ---`);
		parts.push(clipped ? text.slice(0, MAX_INLINE_RESULT_CHARS) : text);
	} else if (structured?.summary) {
		parts.push(`\nSummary:\n${structured.summary}`);
	} else {
		parts.push("\n--- No result yet ---");
	}

	const stderr = result.stderr?.trim();
	if (stderr) {
		parts.push("\nStderr (tail):");
		parts.push(stderr.length > MAX_INLINE_STDERR_CHARS ? `...${stderr.slice(-MAX_INLINE_STDERR_CHARS)}` : stderr);
	}
}

function compactStructuredForDetails(structured: AgentResult["structured"]): AgentResult["structured"] {
	if (!structured) return undefined;
	const { resultText: _resultText, ...compact } = structured;
	return compact;
}

function appendList<T>(parts: string[], title: string, items: readonly T[], format: (item: T) => string, limit: number): void {
	const visible = items.slice(0, limit);
	parts.push(`\n${title}:`);
	for (const item of visible) parts.push(`- ${format(item)}`);
	if (items.length > visible.length) parts.push(`- ... ${items.length - visible.length} more in the full result`);
}

function formatFinding(finding: StructuredFinding): string {
	const suffixes: string[] = [];
	if (finding.severity) suffixes.push(`severity=${finding.severity}`);
	if (finding.file) suffixes.push(`file=${formatFileLocation(finding.file, finding.line)}`);
	const suffix = suffixes.length ? ` (${suffixes.join(", ")})` : "";
	return `${truncate(finding.text, 500)}${suffix}`;
}

function formatFileReference(file: StructuredFileReference): string {
	return formatFileLocation(file.path, file.line);
}

function formatRisk(risk: StructuredRisk): string {
	const severity = risk.severity ? `[${risk.severity}] ` : "";
	return `${severity}${truncate(risk.text, 500)}`;
}

function formatFileLocation(filePath: string, line?: number): string {
	return line ? `${filePath}:${line}` : filePath;
}
