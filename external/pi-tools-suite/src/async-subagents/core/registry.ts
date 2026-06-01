import * as fs from "node:fs";
import * as path from "node:path";
import { getRunRoot, isDir, resolveRunDir } from "./paths.js";

export const SUBAGENT_REGISTRY_FILE = "registry.json";

export interface SubagentRegistryRun {
	runId: string;
	runDir: string;
	agentIds: string[];
	createdAt: string;
	updatedAt: string;
}

export interface SubagentRegistryAgent {
	agentId: string;
	runId: string;
	runDir: string;
	updatedAt: string;
}

export interface SubagentRegistry {
	version: 1;
	latestRunId?: string;
	latestRunDir?: string;
	runs: Record<string, SubagentRegistryRun>;
	agents: Record<string, SubagentRegistryAgent>;
}

function emptyRegistry(): SubagentRegistry {
	return { version: 1, runs: {}, agents: {} };
}

export function getSubagentRegistryPath(cwd: string): string {
	return path.join(getRunRoot(cwd), SUBAGENT_REGISTRY_FILE);
}

export function loadSubagentRegistry(cwd: string): SubagentRegistry {
	try {
		const parsed = JSON.parse(fs.readFileSync(getSubagentRegistryPath(cwd), "utf-8"));
		if (!isRecord(parsed)) return emptyRegistry();
		const registry = emptyRegistry();
		if (typeof parsed.latestRunId === "string") registry.latestRunId = parsed.latestRunId;
		if (typeof parsed.latestRunDir === "string") registry.latestRunDir = parsed.latestRunDir;
		if (isRecord(parsed.runs)) {
			for (const [runId, value] of Object.entries(parsed.runs)) {
				const run = normalizeRegistryRun(runId, value);
				if (run) registry.runs[runId] = run;
			}
		}
		if (isRecord(parsed.agents)) {
			for (const [agentId, value] of Object.entries(parsed.agents)) {
				const agent = normalizeRegistryAgent(agentId, value);
				if (agent) registry.agents[agentId] = agent;
			}
		}
		return registry;
	} catch {
		return emptyRegistry();
	}
}

export function saveSubagentRegistry(cwd: string, registry: SubagentRegistry): void {
	const registryPath = getSubagentRegistryPath(cwd);
	fs.mkdirSync(path.dirname(registryPath), { recursive: true });
	fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
}

export function recordSubagentRun(cwd: string, runDir: string, agentIds: string[]): SubagentRegistry {
	const registry = loadSubagentRegistry(cwd);
	const resolvedRunDir = path.resolve(runDir);
	const runId = path.basename(resolvedRunDir);
	const now = new Date().toISOString();
	const uniqueAgentIds = [...new Set(agentIds.filter((id) => id.trim().length > 0))];
	const previous = registry.runs[runId];
	registry.runs[runId] = {
		runId,
		runDir: resolvedRunDir,
		agentIds: uniqueAgentIds,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
	};
	registry.latestRunId = runId;
	registry.latestRunDir = resolvedRunDir;
	for (const agentId of uniqueAgentIds) {
		registry.agents[agentId] = { agentId, runId, runDir: resolvedRunDir, updatedAt: now };
	}
	saveSubagentRegistry(cwd, registry);
	return registry;
}

export function removeSubagentRunsFromRegistry(cwd: string, runDirs: string[]): SubagentRegistry {
	const registry = loadSubagentRegistry(cwd);
	const removed = new Set(runDirs.map((runDir) => normalizePath(runDir)));
	for (const [runId, run] of Object.entries(registry.runs)) {
		if (removed.has(normalizePath(run.runDir))) delete registry.runs[runId];
	}
	for (const [agentId, agent] of Object.entries(registry.agents)) {
		if (removed.has(normalizePath(agent.runDir))) delete registry.agents[agentId];
	}
	refreshLatestRun(registry);
	saveSubagentRegistry(cwd, registry);
	return registry;
}

export function resolveSubagentRunDir(cwd: string, runDir?: string): string {
	if (hasText(runDir)) return resolveRunDir(cwd, runDir);
	const latest = findLatestSubagentRunDir(cwd);
	if (latest) return latest;
	throw new Error(`runDir was omitted and no sub-agent runs were found under ${getRunRoot(cwd)}.`);
}

export function resolveSubagentAgentRunDir(cwd: string, agentId: string, runDir?: string): string {
	if (hasText(runDir)) return resolveRunDir(cwd, runDir);
	const registered = loadSubagentRegistry(cwd).agents[agentId]?.runDir;
	if (registered && hasAgentRecord(registered, agentId)) return registered;
	const scanned = findSubagentRunDirsForAgent(cwd, agentId)[0];
	if (scanned) return scanned;
	throw new Error(`runDir was omitted and agent "${agentId}" was not found under ${getRunRoot(cwd)}.`);
}

export function findLatestSubagentRunDir(cwd: string): string | undefined {
	const registry = loadSubagentRegistry(cwd);
	const latest = registry.latestRunDir;
	if (latest && isDir(latest)) return latest;
	const registered = Object.values(registry.runs)
		.filter((run) => isDir(run.runDir))
		.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	if (registered[0]) return registered[0].runDir;
	return listSubagentRunDirs(cwd)[0];
}

export function findSubagentRunDirsForAgent(cwd: string, agentId: string): string[] {
	return listSubagentRunDirs(cwd).filter((runDir) => hasAgentRecord(runDir, agentId));
}

export function listSubagentRunDirs(cwd: string): string[] {
	const root = getRunRoot(cwd);
	if (!isDir(root)) return [];
	return fs.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(root, entry.name))
		.filter(looksLikeRunDir)
		.sort((a, b) => statMtimeMs(b) - statMtimeMs(a));
}

function refreshLatestRun(registry: SubagentRegistry): void {
	const latest = Object.values(registry.runs)
		.filter((run) => isDir(run.runDir))
		.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
	if (latest) {
		registry.latestRunId = latest.runId;
		registry.latestRunDir = latest.runDir;
		return;
	}
	delete registry.latestRunId;
	delete registry.latestRunDir;
}

function looksLikeRunDir(runDir: string): boolean {
	if (isDir(path.join(runDir, "prompts"))) return true;
	try {
		return fs.readdirSync(runDir, { withFileTypes: true })
			.some((entry) => entry.isDirectory() && fs.existsSync(path.join(runDir, entry.name, "prompt.md")));
	} catch {
		return false;
	}
}

function hasAgentRecord(runDir: string, agentId: string): boolean {
	return fs.existsSync(path.join(runDir, agentId, "prompt.md"))
		|| fs.existsSync(path.join(runDir, "prompts", `${agentId}.md`));
}

function normalizeRegistryRun(runId: string, value: unknown): SubagentRegistryRun | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.runDir !== "string") return undefined;
	const agentIds = Array.isArray(value.agentIds)
		? value.agentIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
		: [];
	return {
		runId: typeof value.runId === "string" ? value.runId : runId,
		runDir: value.runDir,
		agentIds,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
	};
}

function normalizeRegistryAgent(agentId: string, value: unknown): SubagentRegistryAgent | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.runDir !== "string" || typeof value.runId !== "string") return undefined;
	return {
		agentId: typeof value.agentId === "string" ? value.agentId : agentId,
		runId: value.runId,
		runDir: value.runDir,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasText(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function statMtimeMs(filePath: string): number {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return 0;
	}
}

function normalizePath(filePath: string): string {
	const resolved = path.resolve(filePath);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}
