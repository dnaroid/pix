import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SUBAGENT_PARENT_SESSION_FILE, SUBAGENTS_REGISTRY_FILE, SUBAGENTS_RUN_ROOT } from "../constants.js";
import { isSubagentRegistry } from "./subagents-model.js";
import type { SubagentAgentState, SubagentRegistry } from "../types.js";

export function subagentsRegistryPath(cwd: string): string {
	return join(cwd, SUBAGENTS_RUN_ROOT, SUBAGENTS_REGISTRY_FILE);
}

export async function readSubagentRegistry(cwd: string): Promise<SubagentRegistry | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(subagentsRegistryPath(cwd), "utf8"));
		return isSubagentRegistry(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function readSubagentRunStateFromFiles(
	runDir: string,
	options: { includeLineCounts?: boolean } = {},
): Promise<{ runDir: string; agents: SubagentAgentState[] } | undefined> {
	if (!(await isDirectory(runDir))) return undefined;
	const includeLineCounts = options.includeLineCounts ?? true;

	const agents: SubagentAgentState[] = [];
	const launchedIds = new Set<string>();
	let entries: { isDirectory(): boolean; name: string }[];
	try {
		entries = await readdir(runDir, { withFileTypes: true });
	} catch {
		return undefined;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const state = await readSubagentAgentState(runDir, entry.name, { includeLineCounts });
		if (!state) continue;
		agents.push(state);
		launchedIds.add(entry.name);
	}

	const promptsDir = join(runDir, "prompts");
	try {
		for (const prompt of await readdir(promptsDir)) {
			if (!prompt.endsWith(".md")) continue;
			const id = prompt.slice(0, -3);
			if (!id || launchedIds.has(id)) continue;
			agents.push({ id, status: "planned" });
		}
	} catch {
		// Missing prompts directory is fine for older/partial runs.
	}

	return { runDir, agents };
}

export async function subagentRunHasParentSession(runDir: string, parentSessionFile: string | undefined): Promise<boolean> {
	if (!parentSessionFile || !(await isDirectory(runDir))) return false;

	const normalizedParent = await normalizeExistingPath(parentSessionFile);
	let entries: { isDirectory(): boolean; name: string }[];
	try {
		entries = await readdir(runDir, { withFileTypes: true });
	} catch {
		return false;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const parentSession = await readTrimmedFile(join(runDir, entry.name, SUBAGENT_PARENT_SESSION_FILE));
		if (!parentSession) continue;
		if (await pathsEqual(parentSession, normalizedParent)) return true;
	}

	return false;
}

async function readSubagentAgentState(
	runDir: string,
	agentId: string,
	options: { includeLineCounts: boolean },
): Promise<SubagentAgentState | undefined> {
	const agentDir = join(runDir, agentId);
	if (!(await isDirectory(agentDir))) return undefined;
	if (!(await fileExists(join(agentDir, "prompt.md")))) return undefined;

	const state: SubagentAgentState = { id: agentId, status: "planned" };
	const pid = await readNumberFile(join(agentDir, "pid"));
	if (pid !== undefined) state.pid = pid;

	const exitCodeFile = join(agentDir, "exit_code");
	if (await fileExists(exitCodeFile)) {
		const code = await readNumberFile(exitCodeFile);
		if (code === undefined) {
			state.status = "stopped";
		} else {
			state.exitCode = code;
			state.status = code === 0 ? "done" : "failed";
		}
	} else if (pid !== undefined) {
		try {
			process.kill(pid, 0);
			state.status = "running";
		} catch {
			state.status = "stopped";
		}
	}

	const startedAt = await readTrimmedFile(join(agentDir, "started_at"));
	if (startedAt) state.startedAt = startedAt;
	const finishedAt = await readTrimmedFile(join(agentDir, "finished_at"));
	if (finishedAt) state.finishedAt = finishedAt;

	const retryPending = await fileExists(join(agentDir, "retry_pending"));
	const stopRequested = await fileExists(join(agentDir, "stop_requested"));
	if (retryPending && !stopRequested && state.status !== "running" && state.status !== "done") {
		state.status = "retrying";
		const nextRetryAt = await readTrimmedFile(join(agentDir, "next_retry_at"));
		if (nextRetryAt) state.nextRetryAt = nextRetryAt;
	}

	if (options.includeLineCounts) {
		const resultLines = await countFileLines(join(agentDir, "result.md"));
		if (resultLines !== undefined) state.resultLines = resultLines;
		const stderrLines = await countFileLines(join(agentDir, "stderr.log"));
		if (stderrLines !== undefined && stderrLines > 0) state.stderrLines = stderrLines;
		const eventLines = await countFileLines(join(agentDir, "events.jsonl"));
		if (eventLines !== undefined) state.eventLines = eventLines;
	}

	const retryCount = await readNumberFile(join(agentDir, "retry_count"));
	if (retryCount !== undefined && retryCount > 0) state.retryCount = retryCount;

	return state;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function pathsEqual(filePath: string, normalizedTarget: string): Promise<boolean> {
	return await normalizeExistingPath(filePath) === normalizedTarget;
}

async function normalizeExistingPath(filePath: string): Promise<string> {
	const resolved = resolve(filePath);
	try {
		return await realpath(resolved);
	} catch {
		return resolved;
	}
}

async function isDirectory(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isDirectory();
	} catch {
		return false;
	}
}

async function readTrimmedFile(filePath: string): Promise<string | undefined> {
	try {
		const value = (await readFile(filePath, "utf8")).trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

async function readNumberFile(filePath: string): Promise<number | undefined> {
	const raw = await readTrimmedFile(filePath);
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) ? value : undefined;
}

async function countFileLines(filePath: string): Promise<number | undefined> {
	try {
		const content = await readFile(filePath, "utf8");
		if (content.length === 0) return 0;
		const newlineCount = content.split("\n").length - 1;
		return content.endsWith("\n") ? newlineCount : newlineCount + 1;
	} catch {
		return undefined;
	}
}
