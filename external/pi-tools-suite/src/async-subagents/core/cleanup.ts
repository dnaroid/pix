import * as fs from "node:fs";
import * as path from "node:path";
import { hasLaunchedAgentPrompt, isDir } from "./paths.js";
import { ownedArtifactsPresentSync, ownedDeletableSync } from "./owned-retirement.js";

export function findCleanupCandidates(
	runRoot: string,
	days = 7,
	keep = 20,
): string[] {
	if (!isDir(runRoot)) return [];

	const runDirs = fs
		.readdirSync(runRoot, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => path.join(runRoot, e.name))
		.sort()
		.reverse();

	const candidates: string[] = [];
	const cutoffMs = days * 24 * 60 * 60 * 1000;

	for (let i = 0; i < runDirs.length; i++) {
		if (i < keep) continue;
		const runDir = runDirs[i];
		if (!isCompletedRun(runDir)) continue;
		try {
			const stat = fs.statSync(runDir);
			if (Date.now() - stat.mtimeMs < cutoffMs) continue;
		} catch {
			continue;
		}
		candidates.push(runDir);
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
): string[] {
	const candidates = findCleanupCandidates(runRoot, days, keep);
	deleteRunDirs(candidates);
	return candidates;
}

function isCompletedRun(runDir: string): boolean {
	let foundAgent = false;
	for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!hasLaunchedAgentPrompt(runDir, entry.name)) continue;
		const agentDir = path.join(runDir, entry.name);
		foundAgent = true;
		// Unknown ownership fails closed: any owned-launch artifact without a
		// verified drain + retirement proof keeps the run undeletable.
		if (ownedArtifactsPresentSync(agentDir) && !ownedDeletableSync(agentDir)) return false;
		if (!fs.existsSync(path.join(agentDir, "exit_code"))) return false;
	}
	return foundAgent;
}

function hasUndeletableOwnedAgent(runDir: string): boolean {
	if (!isDir(runDir)) return false;
	return fs.readdirSync(runDir, { withFileTypes: true }).some((entry) => entry.isDirectory() &&
		ownedArtifactsPresentSync(path.join(runDir, entry.name)) &&
		!ownedDeletableSync(path.join(runDir, entry.name)));
}
