import * as fs from "node:fs";
import * as path from "node:path";
import { getRunRoot, hasAgentPrompt, hasLaunchedAgentPrompt, isDir, resolveRunDir } from "./paths.js";

export const SUBAGENT_REGISTRY_FILE = "registry.json";

const REGISTRY_LOCK_RETRY_MS = 10;
const REGISTRY_LOCK_TIMEOUT_MS = 2_000;
const REGISTRY_LOCK_STALE_MS = 30_000;

interface RegistryLockOwner {
	pid: number;
	token: string;
}

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
	withRegistryLock(registryPath, () => writeRegistryAtomically(registryPath, registry));
}

export function recordSubagentRun(cwd: string, runDir: string, agentIds: string[]): SubagentRegistry {
	return updateSubagentRegistry(cwd, (registry) => {
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
		return registry;
	});
}

export function removeSubagentRunsFromRegistry(cwd: string, runDirs: string[]): SubagentRegistry {
	return updateSubagentRegistry(cwd, (registry) => {
		const removed = new Set(runDirs.map((runDir) => normalizePath(runDir)));
		for (const [runId, run] of Object.entries(registry.runs)) {
			if (removed.has(normalizePath(run.runDir))) delete registry.runs[runId];
		}
		for (const [agentId, agent] of Object.entries(registry.agents)) {
			if (removed.has(normalizePath(agent.runDir))) delete registry.agents[agentId];
		}
		refreshLatestRun(registry);
		return registry;
	});
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

function updateSubagentRegistry(cwd: string, update: (registry: SubagentRegistry) => SubagentRegistry): SubagentRegistry {
	const registryPath = getSubagentRegistryPath(cwd);
	return withRegistryLock(registryPath, () => {
		const registry = loadSubagentRegistry(cwd);
		const updated = update(registry);
		writeRegistryAtomically(registryPath, updated);
		return updated;
	});
}

function withRegistryLock<T>(registryPath: string, operation: () => T): T {
	fs.mkdirSync(path.dirname(registryPath), { recursive: true });
	const lockPath = `${registryPath}.lock`;
	const owner = registryLockOwner();
	const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;
	while (!createRegistryLock(lockPath, owner)) {
		recoverStaleRegistryLock(lockPath, owner);
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for sub-agent registry lock at ${lockPath}.`);
		}
		sleep(REGISTRY_LOCK_RETRY_MS);
	}
	try {
		return operation();
	} finally {
		releaseRegistryLock(lockPath, owner);
	}
}

function writeRegistryAtomically(registryPath: string, registry: SubagentRegistry): void {
	const temporaryPath = `${registryPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		fs.writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		fs.renameSync(temporaryPath, registryPath);
	} finally {
		fs.rmSync(temporaryPath, { force: true });
	}
}

function registryLockOwner(): RegistryLockOwner {
	return { pid: process.pid, token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}` };
}

function createRegistryLock(lockPath: string, owner: RegistryLockOwner): boolean {
	try {
		fs.writeFileSync(lockPath, JSON.stringify(owner), { encoding: "utf-8", mode: 0o600, flag: "wx" });
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	}
}

function recoverStaleRegistryLock(lockPath: string, owner: RegistryLockOwner): void {
	let lockStat: fs.Stats;
	try {
		lockStat = fs.statSync(lockPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	const existingOwner = readRegistryLockOwner(lockPath);
	const lockAgeMs = Date.now() - lockStat.mtimeMs;
	if (existingOwner && isProcessAlive(existingOwner.pid)) return;
	if (!existingOwner && lockAgeMs <= REGISTRY_LOCK_STALE_MS) return;

	const quarantinePath = `${lockPath}.stale-${owner.token}`;
	try {
		fs.renameSync(lockPath, quarantinePath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	try {
		const movedStat = fs.statSync(quarantinePath);
		if (movedStat.dev !== lockStat.dev || movedStat.ino !== lockStat.ino) return;
		fs.rmSync(quarantinePath, { force: true });
	} finally {
		if (fs.existsSync(quarantinePath) && !fs.existsSync(lockPath)) {
			fs.renameSync(quarantinePath, lockPath);
		}
	}
}

function releaseRegistryLock(lockPath: string, owner: RegistryLockOwner): void {
	if (readRegistryLockOwner(lockPath)?.token === owner.token) fs.rmSync(lockPath, { force: true });
}

function readRegistryLockOwner(lockPath: string): RegistryLockOwner | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		if (!isRecord(parsed) || typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.token !== "string") return undefined;
		return { pid: parsed.pid, token: parsed.token };
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function looksLikeRunDir(runDir: string): boolean {
	if (isDir(path.join(runDir, "prompts"))) return true;
	try {
		return fs.readdirSync(runDir, { withFileTypes: true })
			.some((entry) => entry.isDirectory() && hasLaunchedAgentPrompt(runDir, entry.name));
	} catch {
		return false;
	}
}

function hasAgentRecord(runDir: string, agentId: string): boolean {
	return hasAgentPrompt(runDir, agentId);
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
