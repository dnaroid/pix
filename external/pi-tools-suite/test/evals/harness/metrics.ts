import * as fs from "node:fs";
import * as path from "node:path";
import type { EvalEvent, EvalMetrics, EvalUsage } from "./types.js";

const EMPTY_USAGE: EvalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
const MUTATION_TOOLS = new Set(["edit", "Edit", "write", "Write", "apply_patch", "ast_apply"]);
const SHELL_TOOLS = new Set(["bash", "Bash", "shell", "shell_command"]);
const VERIFY_COMMAND = /(?:^|\s)(?:npm|pnpm|yarn|bun|node|npx|pytest|python|cargo|go|make)\b[^\n]*(?:test|check|lint|typecheck|verify)|(?:^|\s)(?:pytest|go\s+test|cargo\s+test)\b/i;

export function emptyUsage(): EvalUsage {
	return { ...EMPTY_USAGE };
}

export function addUsage(target: EvalUsage, source: Partial<EvalUsage> | undefined): void {
	if (!source) return;
	target.input += finite(source.input);
	target.output += finite(source.output);
	target.cacheRead += finite(source.cacheRead);
	target.cacheWrite += finite(source.cacheWrite);
	target.totalTokens += finite(source.totalTokens);
	target.cost += finite(source.cost);
}

export function isMutationTool(name: string | undefined): boolean {
	return Boolean(name && MUTATION_TOOLS.has(name));
}

export function isVerificationCall(event: EvalEvent): boolean {
	if (event.type !== "tool_call" || !event.toolName || !SHELL_TOOLS.has(event.toolName)) return false;
	const input = isRecord(event.input) ? event.input : {};
	const command = [input.command, input.cmd, input.script].find((value) => typeof value === "string");
	return typeof command === "string" && VERIFY_COMMAND.test(command);
}

export function deriveMetrics(options: {
	events: EvalEvent[];
	elapsedMs: number;
	changedFiles: string[];
	projectDir: string;
	sessionDir: string;
}): EvalMetrics {
	const toolCalls = options.events.filter((event) => event.type === "tool_call").map((event) => event.toolName ?? "unknown");
	const eventUsage = emptyUsage();
	for (const event of options.events) if (event.type === "agent_end") addUsage(eventUsage, event.usage);
	const parentUsage = eventUsage.totalTokens > 0 || eventUsage.cost > 0 ? eventUsage : readUsageFromTree(options.sessionDir);
	const subagent = readSubagentUsage(options.projectDir);
	return {
		elapsedMs: options.elapsedMs,
		toolCallCount: toolCalls.length,
		toolCalls,
		failedToolResults: options.events.filter((event) => event.type === "tool_result" && event.isError).length,
		mutationCount: options.events.filter((event) => event.type === "tool_call" && isMutationTool(event.toolName)).length,
		verificationCount: options.events.filter(isVerificationCall).length,
		changedFiles: options.changedFiles,
		parentUsage,
		subagentUsage: subagent.usage,
		subagentCount: subagent.count,
	};
}

function readSubagentUsage(projectDir: string): { usage: EvalUsage; count: number } {
	const root = path.join(projectDir, ".pi", "subagents");
	if (!safeIsDirectory(root)) return { usage: emptyUsage(), count: 0 };
	const usage = emptyUsage();
	let count = 0;
	for (const run of safeReaddir(root)) {
		const runDir = path.join(root, run);
		if (!safeIsDirectory(runDir)) continue;
		for (const agent of safeReaddir(runDir)) {
			const agentDir = path.join(runDir, agent);
			if (!safeIsDirectory(agentDir)) continue;
			count += 1;
			const sessionDir = readOptional(path.join(agentDir, "session_dir")).trim();
			const sessionFile = readOptional(path.join(agentDir, "session_file")).trim();
			addUsage(usage, readUsageFromTree(sessionDir || sessionFile || path.join(agentDir, "session")));
		}
	}
	return { usage, count };
}

function readUsageFromTree(target: string): EvalUsage {
	const usage = emptyUsage();
	if (!target || !fs.existsSync(target)) return usage;
	const files = safeIsDirectory(target) ? collectJsonFiles(target) : [target];
	for (const file of files) {
		const text = readOptional(file);
		for (const value of parseJsonArtifacts(text)) collectTopLevelAssistantUsage(value, usage);
	}
	return usage;
}

function collectTopLevelAssistantUsage(value: unknown, usage: EvalUsage): void {
	if (Array.isArray(value)) {
		for (const item of value) collectTopLevelAssistantUsage(item, usage);
		return;
	}
	if (!isRecord(value)) return;
	if (value.role === "assistant" && isRecord(value.usage)) addUsage(usage, normalizeUsage(value.usage));
	if (value.type === "message_end" && isRecord(value.message) && value.message.role === "assistant" && isRecord(value.message.usage)) {
		addUsage(usage, normalizeUsage(value.message.usage));
	}
}

function normalizeUsage(raw: Record<string, unknown>): EvalUsage {
	const cost = isRecord(raw.cost) ? finite(raw.cost.total) : 0;
	const totalTokens = finite(raw.totalTokens ?? raw.total_tokens);
	return {
		input: finite(raw.input ?? raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens),
		output: finite(raw.output ?? raw.outputTokens ?? raw.output_tokens ?? raw.completionTokens ?? raw.completion_tokens),
		cacheRead: finite(raw.cacheRead ?? raw.cache_read),
		cacheWrite: finite(raw.cacheWrite ?? raw.cache_write),
		totalTokens,
		cost,
	};
}

function collectJsonFiles(root: string): string[] {
	const files: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (safeIsDirectory(current)) {
			for (const name of safeReaddir(current)) stack.push(path.join(current, name));
		} else if (/\.(?:json|jsonl)$/i.test(current) || path.basename(current).includes("session")) files.push(current);
	}
	return files;
}

function parseJsonArtifacts(text: string): unknown[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	try {
		return [JSON.parse(trimmed)];
	} catch {
		const values: unknown[] = [];
		for (const line of trimmed.split("\n")) {
			try { values.push(JSON.parse(line)); } catch { /* ignore */ }
		}
		return values;
	}
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIsDirectory(target: string): boolean {
	try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

function safeReaddir(target: string): string[] {
	try { return fs.readdirSync(target); } catch { return []; }
}

function readOptional(target: string): string {
	try { return fs.readFileSync(target, "utf8"); } catch { return ""; }
}
