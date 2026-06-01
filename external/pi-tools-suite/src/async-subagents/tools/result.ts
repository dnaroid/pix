import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import * as path from "node:path";
import { ASYNC_SUBAGENT_TOOL_DESCRIPTIONS } from "../../tool-descriptions.js";
import { readResult, resolveSubagentAgentRunDir, validateBasename } from "../lib.js";
import type { AgentResult } from "../lib.js";
import type { StructuredFileReference, StructuredFinding, StructuredRisk } from "../core/types.js";
import { INLINE_RENDERING } from "../constants.js";
import { truncate } from "../format.js";
import { emptyToolSlot } from "../ui.js";

const MAX_COMPACT_FINDINGS = 10;
const MAX_COMPACT_FILES = 20;
const MAX_COMPACT_RISKS = 10;
const MAX_COMPACT_NEXT_ACTIONS = 10;

interface ResultArtifactPaths {
	resultMd: string;
	resultJson: string;
	stderrLog: string;
}

export function registerResultTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...ASYNC_SUBAGENT_TOOL_DESCRIPTIONS.resultAction,
		...INLINE_RENDERING,
		parameters: Type.Object({
			runDir: Type.Optional(Type.String({ description: "Run directory path. If omitted, resolves agentId through the project sub-agent registry under .pi/subagents/registry.json, falling back to scanning .pi/subagents/." })),
			agentId: Type.String({ description: "Agent ID to read" }),
			compact: Type.Optional(Type.Boolean({ description: "Return summary and artifact paths instead of raw output (default true); set false for full result/stderr", default: true })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			validateBasename(params.agentId, "agentId");
			const runDir = resolveSubagentAgentRunDir(ctx.cwd, params.agentId, params.runDir);
			const result = readResult(runDir, params.agentId);

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
				parts.push("\nAgent is still running. Wait for it to finish or inspect the artifact paths below.");
			}
			const artifacts = buildArtifactPaths(ctx.cwd, runDir, params.agentId);

			// Include structured metadata when available
			if (result.structured) {
				const s = result.structured;
				if (s.durationSeconds !== undefined) parts.push(`Duration: ${s.durationSeconds}s`);
				if (s.subagentType) parts.push(`Type: ${s.subagentType}`);
				if (s.model) parts.push(`Model: ${s.model}`);
				if (s.resultTruncated) parts.push(`Result truncated: ${s.resultOriginalBytes} bytes → maxResultBytes`);
				if (params.compact === false) {
					if (s.summary) parts.push(`Summary: ${s.summary}`);
					if (s.confidence) parts.push(`Confidence: ${s.confidence}`);
					if (s.findings?.length) parts.push(`Structured findings: ${s.findings.length}`);
					if (s.files?.length) parts.push(`Referenced files: ${s.files.length}`);
					if (s.nextActions?.length) parts.push(`Next actions: ${s.nextActions.length}`);
				}
			}

			if (params.compact !== false) {
				appendCompactResult(parts, result, artifacts, params.agentId);
			} else if (result.result) {
				parts.push(`\n--- Result ---\n${result.result}`);
			} else {
				parts.push("\n--- No result yet ---");
			}

			if (params.compact === false && result.stderr) {
				parts.push(`\n--- Stderr ---\n${result.stderr}`);
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: {
					runDir,
					agentId: params.agentId,
					state: result.state,
					exitCode: result.exitCode,
					structured: result.structured,
					artifacts,
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

function buildArtifactPaths(cwd: string, runDir: string, agentId: string): ResultArtifactPaths {
	const agentDir = path.join(runDir, agentId);
	return {
		resultMd: displayPath(cwd, path.join(agentDir, "result.md")),
		resultJson: displayPath(cwd, path.join(agentDir, "result.json")),
		stderrLog: displayPath(cwd, path.join(agentDir, "stderr.log")),
	};
}

function displayPath(cwd: string, filePath: string): string {
	const relative = path.relative(cwd, filePath);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
	return filePath;
}

function appendCompactResult(parts: string[], result: AgentResult, artifacts: ResultArtifactPaths, agentId: string): void {
	const structured = result.structured;

	if (structured?.summary) {
		parts.push(`\nSummary:\n${structured.summary}`);
	} else if (result.result !== undefined) {
		parts.push("\nSummary:\n(summary unavailable; see the full result artifact below)");
	} else {
		parts.push("\n--- No result yet ---");
	}

	if (structured?.confidence) parts.push(`Confidence: ${structured.confidence}`);
	if (structured?.findings?.length) appendList(parts, "Findings", structured.findings, formatFinding, MAX_COMPACT_FINDINGS);
	if (structured?.files?.length) appendList(parts, "Referenced files", structured.files, formatFileReference, MAX_COMPACT_FILES);
	if (structured?.risks?.length) appendList(parts, "Risks", structured.risks, formatRisk, MAX_COMPACT_RISKS);
	if (structured?.nextActions?.length) appendList(parts, "Next actions", structured.nextActions, (action) => truncate(action, 500), MAX_COMPACT_NEXT_ACTIONS);

	if (result.stderr) {
		parts.push("\nStderr:");
		if (structured?.stderrPreview) parts.push(`Preview: ${structured.stderrPreview}`);
		parts.push(`Full stderr: ${artifacts.stderrLog}`);
	}

	parts.push("\nArtifacts:");
	parts.push(`${result.result !== undefined ? "Full result" : "Full result (not written yet)"}: ${artifacts.resultMd}`);
	parts.push(`${structured ? "Structured result" : "Structured result (not available yet)"}: ${artifacts.resultJson}`);
	parts.push(`To read full output: subagents({ action: "result", agentId: "${agentId}", compact: false })`);
}

function appendList<T>(parts: string[], title: string, items: readonly T[], format: (item: T) => string, limit: number): void {
	const visible = items.slice(0, limit);
	parts.push(`\n${title}:`);
	for (const item of visible) parts.push(`- ${format(item)}`);
	if (items.length > visible.length) parts.push(`- ... ${items.length - visible.length} more in result.json`);
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
