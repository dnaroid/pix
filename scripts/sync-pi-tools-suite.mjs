#!/usr/bin/env node
// Mechanized sync of the bundled `pi-tools-suite` extension into the Pi agent
// extensions directory (~/.pi/agent/extensions/pi-tools-suite by default).
//
// Replaces the former manual "copy + cmp/grep + restart" workflow. Only
// source-bearing entries are mirrored; environment-specific entries
// (node_modules, test, .git, package-lock.json, .pi, opencode) at the
// target are preserved.
//
// Usage:
//   node scripts/sync-pi-tools-suite.mjs            # mirror source -> target
//   node scripts/sync-pi-tools-suite.mjs --check    # report drift only, no writes
//   node scripts/sync-pi-tools-suite.mjs --target <path>
//   node scripts/sync-pi-tools-suite.mjs --source <path>

import { cp, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const DEFAULT_SOURCE = resolve(REPO_ROOT, "external", "pi-tools-suite");
const DEFAULT_TARGET = resolve(homedir(), ".pi", "agent", "extensions", "pi-tools-suite");

// Entries mirrored verbatim from source to target. Everything else at the
// target is left untouched (it is environment-specific).
const MIRROR_ENTRIES = [
	"src",
	"docs",
	"licenses",
	"scripts",
	"index.ts",
	"package.json",
	"README.md",
];

function parseArgs(argv) {
	const options = { check: false, source: DEFAULT_SOURCE, target: DEFAULT_TARGET };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--check") {
			options.check = true;
		} else if (arg === "--source") {
			options.source = resolve(argv[++index] ?? "");
		} else if (arg === "--target") {
			options.target = resolve(argv[++index] ?? "");
		} else if (arg === "-h" || arg === "--help") {
			printUsage();
			process.exit(0);
		} else {
			console.error(`Unknown argument: ${arg}`);
			printUsage();
			process.exit(2);
		}
	}
	return options;
}

function printUsage() {
	console.error("Usage: sync-pi-tools-suite [--check] [--source <path>] [--target <path>]");
}

function sha256(filePath) {
	const buffer = readFileSync(filePath);
	return createHash("sha256").update(buffer).digest("hex");
}

function collectSourceFiles(sourceRoot) {
	const entries = [];
	for (const name of MIRROR_ENTRIES) {
		const absolutePath = join(sourceRoot, name);
		if (existsSync(absolutePath)) entries.push({ name, absolutePath });
	}
	return entries;
}

// Walk a mirrored entry and return [relativePath, absolutePath] pairs for every
// regular file, so we can checksum-compare against the target.
async function walkFiles(absolutePath) {
	const result = [];
	const stack = [absolutePath];
	while (stack.length > 0) {
		const current = stack.pop();
		let stats;
		try {
			stats = await stat(current);
		} catch {
			continue;
		}
		if (stats.isDirectory()) {
			const children = await readdir(current);
			for (const child of children) stack.push(join(current, child));
		} else if (stats.isFile()) {
			result.push(current);
		}
	}
	return result;
}

async function computeSyncPlan(sourceRoot, targetRoot) {
	const changes = []; // { rel, status: "add"|"update"|"same" }
	const sourceEntries = collectSourceFiles(sourceRoot);
	for (const entry of sourceEntries) {
		const files = await walkFiles(entry.absolutePath);
		for (const file of files) {
			const rel = relative(sourceRoot, file);
			const targetFile = join(targetRoot, rel);
			let sourceHash;
			try {
				sourceHash = sha256(file);
			} catch {
				continue;
			}
			let status;
			if (!existsSync(targetFile)) {
				status = "add";
			} else {
				let targetHash;
				try {
					targetHash = sha256(targetFile);
				} catch {
					status = "add";
				}
				status = targetHash === sourceHash ? "same" : "update";
			}
			changes.push({ rel, status });
		}
	}
	return changes;
}

async function mirrorEntry(sourceEntry, targetRoot) {
	const targetEntry = join(targetRoot, sourceEntry.name);
	// Remove the stale target entry so copies are exact (avoids leftover files).
	await rm(targetEntry, { force: true, recursive: true });
	await cp(sourceEntry.absolutePath, targetEntry, {
		recursive: true,
		force: true,
		// Preserve timestamps so repeated no-op syncs are cheap to verify.
		preserveTimestamps: true,
	});
}

async function main() {
	const options = parseArgs(process.argv.slice(2));

	if (!existsSync(options.source)) {
		console.error(`[sync-pi-tools-suite] source missing: ${options.source}`);
		process.exitCode = 1;
		return;
	}

	const plan = await computeSyncPlan(options.source, options.target);
	const additions = plan.filter((c) => c.status === "add");
	const updates = plan.filter((c) => c.status === "update");
	const same = plan.filter((c) => c.status === "same");

	console.error(`[sync-pi-tools-suite] source: ${options.source}`);
	console.error(`[sync-pi-tools-suite] target: ${options.target}`);
	console.error(`[sync-pi-tools-suite] same:${same.length} add:${additions.length} update:${updates.length}`);

	if (additions.length > 0) {
		console.error("[sync-pi-tools-suite] new files:");
		for (const change of additions) console.error(`  + ${change.rel}`);
	}
	if (updates.length > 0) {
		console.error("[sync-pi-tools-suite] changed files:");
		for (const change of updates) console.error(`  ~ ${change.rel}`);
	}

	if (options.check) {
		// Non-zero exit when drift exists, for use in CI / pre-flight checks.
		if (additions.length > 0 || updates.length > 0) process.exitCode = 3;
		return;
	}

	if (additions.length === 0 && updates.length === 0) {
		console.error("[sync-pi-tools-suite] already in sync");
		return;
	}

	const sourceEntries = collectSourceFiles(options.source);
	let mirrored = 0;
	for (const entry of sourceEntries) {
		// Only rewrite entries that actually changed to minimize churn.
		const entryPrefix = `${entry.name}/`;
		const touched = plan.some((change) => change.status !== "same"
			&& (change.rel === entry.name || change.rel.startsWith(entryPrefix)));
		if (!touched) continue;
		await mirrorEntry(entry, options.target);
		mirrored += 1;
		console.error(`[sync-pi-tools-suite] mirrored ${entry.name}`);
	}

	if (mirrored === 0) {
		// Fallback: mirror every entry if the per-entry heuristic missed something.
		for (const entry of sourceEntries) {
			await mirrorEntry(entry, options.target);
			console.error(`[sync-pi-tools-suite] mirrored ${entry.name}`);
		}
	}

	// Verify post-sync state matches the source.
	const after = await computeSyncPlan(options.source, options.target);
	const drift = after.filter((c) => c.status !== "same");
	if (drift.length > 0) {
		console.error(`[sync-pi-tools-suite] verification failed: ${drift.length} files still differ`);
		for (const change of drift) console.error(`  ! ${change.rel}`);
		process.exitCode = 4;
		return;
	}
	console.error("[sync-pi-tools-suite] verified in sync");
}

main().catch((error) => {
	console.error(`[sync-pi-tools-suite] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
