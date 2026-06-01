import * as fs from "node:fs";
import * as path from "node:path";
import { isDir } from "./paths.js";

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
		const agentDir = path.join(runDir, entry.name);
		if (!fs.existsSync(path.join(agentDir, "prompt.md"))) continue;
		foundAgent = true;
		if (!fs.existsSync(path.join(agentDir, "exit_code"))) return false;
	}
	return foundAgent;
}
