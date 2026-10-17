import * as fs from "node:fs";
import * as path from "node:path";
import { isDir, PARENT_SESSION_ID_PATTERN } from "./paths.js";
import { ownedArtifactsPresentSync, ownedDeletableSync } from "./owned-retirement.js";
import { SUBAGENT_META_ENTRY } from "./subagent-meta.js";

/** Obsolete pre-0072 registry file; removed together with legacy run directories. */
export const LEGACY_REGISTRY_FILE = "registry.json";

const META_SCAN_BYTES = 256 * 1024;

export interface CleanupOptions {
	/** Scope (parent session id) of the calling session; never a candidate. */
	currentScope?: string;
}

/**
 * Cleanup candidates under `.pi/subagents/` (decision 0072):
 * - legacy timestamped run directories whose launched agents all finished,
 *   beyond the newest `keep` and older than `days`;
 * - parent-scope directories (`<parentSessionId>/`) whose parent session no
 *   longer exists (or is unknown) and that are older than `days`.
 * Owned-launch records without a verified drain + retirement proof always
 * keep their directory (unknown ownership fails closed).
 */
export function findCleanupCandidates(
	runRoot: string,
	days = 7,
	keep = 20,
	options: CleanupOptions = {},
): string[] {
	if (!isDir(runRoot)) return [];
	const cutoffMs = days * 24 * 60 * 60 * 1000;
	const dirs = fs
		.readdirSync(runRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.reverse();

	const candidates: string[] = [];
	let legacyIndex = 0;
	for (const name of dirs) {
		const dir = path.join(runRoot, name);
		if (PARENT_SESSION_ID_PATTERN.test(name)) {
			if (name === options.currentScope) continue;
			if (!olderThan(dir, cutoffMs, true) || hasUndeletableOwnedAgent(dir)) continue;
			if (scopeParentAlive(dir)) continue;
			candidates.push(dir);
			continue;
		}
		if (legacyIndex++ < keep) continue;
		if (!isCompletedLegacyRun(dir) || !olderThan(dir, cutoffMs)) continue;
		candidates.push(dir);
	}
	return candidates;
}

export function deleteRunDirs(runDirs: string[]): void {
	for (const dir of runDirs) {
		if (hasUndeletableOwnedAgent(dir)) throw new Error(`owned run is not verified drained and retired: ${dir}`);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

export const deleteCleanupCandidates = deleteRunDirs;

export function cleanupCompletedRuns(
	runRoot: string,
	days = 7,
	keep = 20,
	options: CleanupOptions = {},
): string[] {
	const candidates = findCleanupCandidates(runRoot, days, keep, options);
	deleteRunDirs(candidates);
	return candidates;
}

/** Scope dirs age by their newest child session; legacy runs by their own mtime (pre-0072 rule). */
function olderThan(dir: string, cutoffMs: number, includeChildren = false): boolean {
	try {
		const mtimeMs = includeChildren ? newestMtimeMs(dir) : fs.statSync(dir).mtimeMs;
		return Date.now() - mtimeMs >= cutoffMs;
	} catch {
		return false;
	}
}

/** Newest mtime of the directory and its direct children (child sessions keep growing). */
function newestMtimeMs(dir: string): number {
	let newest = fs.statSync(dir).mtimeMs;
	for (const entry of fs.readdirSync(dir)) {
		try {
			newest = Math.max(newest, fs.statSync(path.join(dir, entry)).mtimeMs);
		} catch { /* raced removal */ }
	}
	return newest;
}

function isCompletedLegacyRun(runDir: string): boolean {
	let foundAgent = false;
	for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const agentDir = path.join(runDir, entry.name);
		if (!fs.existsSync(path.join(agentDir, "prompt.md"))) continue;
		foundAgent = true;
		// Unknown ownership fails closed: any owned-launch artifact without a
		// verified drain + retirement proof keeps the run undeletable.
		if (ownedArtifactsPresentSync(agentDir) && !ownedDeletableSync(agentDir)) return false;
		if (!fs.existsSync(path.join(agentDir, "exit_code"))) return false;
	}
	return foundAgent;
}

/** Agent dirs that may hold owned-launch records: `<scope>/owned/<batch>/<agentId>/` or legacy `<run>/<agentId>/`. */
function ownedAgentDirsOf(dir: string): string[] {
	if (!isDir(dir)) return [];
	if (PARENT_SESSION_ID_PATTERN.test(path.basename(dir))) {
		const ownedRoot = path.join(dir, "owned");
		if (!isDir(ownedRoot)) return [];
		return subdirs(ownedRoot).flatMap((batch) => subdirs(batch));
	}
	return subdirs(dir);
}

function subdirs(dir: string): string[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(dir, entry.name));
	} catch {
		return [];
	}
}

function hasUndeletableOwnedAgent(dir: string): boolean {
	return ownedAgentDirsOf(dir).some((agentDir) => ownedArtifactsPresentSync(agentDir) && !ownedDeletableSync(agentDir));
}

/** True when any child session of the scope names a parent session file that still exists. */
function scopeParentAlive(scopeDir: string): boolean {
	for (const file of fs.readdirSync(scopeDir)) {
		if (!file.endsWith(".jsonl")) continue;
		const parent = readParentSession(path.join(scopeDir, file));
		if (parent && fs.existsSync(parent)) return true;
	}
	return false;
}

function readParentSession(file: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const buffer = Buffer.alloc(META_SCAN_BYTES);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
			if (!line.includes(SUBAGENT_META_ENTRY)) continue;
			try {
				const entry = JSON.parse(line) as { type?: string; customType?: string; data?: { parentSession?: unknown } };
				if (entry.type === "custom" && entry.customType === SUBAGENT_META_ENTRY && typeof entry.data?.parentSession === "string")
					return entry.data.parentSession;
			} catch { /* partial trailing line */ }
		}
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	return undefined;
}
