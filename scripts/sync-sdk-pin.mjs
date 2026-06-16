#!/usr/bin/env node
// Keep the bundled `pi-tools-suite` extension's `@earendil-works/*` peer
// dependency pins aligned with the host pi SDK version declared in the root
// package.json.
//
// Problem this solves: the extension runs inside the pi host process, so its
// peerDeps must match the installed host SDK exactly. With loose peer ranges
// (e.g. "*") npm could resolve a stale copy in the suite's own node_modules,
// causing a double-load mine (e.g. 0.75.4 in the suite vs 0.79.4 in the host).
// This script pins and verifies the alignment, following the same convention as
// scripts/sync-pi-tools-suite.mjs (default = apply, --check = report drift).
//
// Usage:
//   node scripts/sync-sdk-pin.mjs               # rewrite suite peerDeps to host version
//   node scripts/sync-sdk-pin.mjs --check       # report drift only, no writes (non-zero exit)
//   node scripts/sync-sdk-pin.mjs --host 0.79.4 # force a specific host version
//   node scripts/sync-sdk-pin.mjs --root <path> # root package.json dir (default: repo root)
//   node scripts/sync-sdk-pin.mjs --package <path> # suite package.json (default: external/pi-tools-suite)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const DEFAULT_ROOT_DIR = REPO_ROOT;
const DEFAULT_PACKAGE = resolve(REPO_ROOT, "external", "pi-tools-suite", "package.json");

// Packages whose suite peerDeps must track the host SDK version. They are pinned
// together in the root package.json; typebox is intentionally NOT synced.
const SYNC_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

function parseArgs(argv) {
	const options = { check: false, host: undefined, rootDir: DEFAULT_ROOT_DIR, packagePath: DEFAULT_PACKAGE };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--check") {
			options.check = true;
		} else if (arg === "--host") {
			options.host = argv[++index];
		} else if (arg === "--root") {
			options.rootDir = resolve(argv[++index] ?? "");
		} else if (arg === "--package") {
			options.packagePath = resolve(argv[++index] ?? "");
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
	console.error("Usage: sync-sdk-pin [--check] [--host <version>] [--root <dir>] [--package <path>]");
}

function readJson(filePath) {
	return JSON.parse(readFileSync(filePath, "utf8"));
}

// Resolve the host version for a given @earendil-works/* package from the root
// package.json dependencies. The three SDK packages are pinned together, so we
// could read any one, but reading each independently is more robust.
function resolveHostVersion(rootDir, packageName, override) {
	if (override) return override;
	const rootPackage = readJson(resolve(rootDir, "package.json"));
	const deps = { ...rootPackage.dependencies, ...rootPackage.devDependencies };
	const version = deps[packageName];
	if (!version) {
		throw new Error(`host version not found for ${packageName} in ${resolve(rootDir, "package.json")} dependencies`);
	}
	return version;
}

function normalizeVersion(version) {
	// Strip npm aliases / ranges so we pin an exact version. Accepts both
	// "0.79.4" and "npm:@earendil-works/pi-coding-agent@0.79.4" forms.
	const match = version.match(/(\d+\.\d+\.\d+(?:[^\s"'`]*)?)/);
	return match ? match[1] : version;
}

function main() {
	const options = parseArgs(process.argv.slice(2));

	const rootPackagePath = resolve(options.rootDir, "package.json");
	if (!options.host) {
		console.error(`[sync-sdk-pin] host package: ${rootPackagePath}`);
	}

	const hostVersions = {};
	for (const name of SYNC_PACKAGES) {
		hostVersions[name] = normalizeVersion(resolveHostVersion(options.rootDir, name, options.host));
	}
	const primaryHost = hostVersions["@earendil-works/pi-coding-agent"];
	console.error(`[sync-sdk-pin] host SDK version: ${primaryHost}`);

	const suiteRaw = readFileSync(options.packagePath, "utf8");
	const suite = JSON.parse(suiteRaw);
	const peerDeps = suite.peerDependencies;
	if (!peerDeps || typeof peerDeps !== "object") {
		console.error(`[sync-sdk-pin] no peerDependencies found in ${options.packagePath}`);
		process.exitCode = 1;
		return;
	}

	const drift = []; // { name, current, expected }
	for (const name of SYNC_PACKAGES) {
		const current = peerDeps[name];
		const expected = hostVersions[name];
		if (current === undefined) {
			console.error(`[sync-sdk-pin] WARNING: ${name} missing from peerDependencies`);
		}
		if (current !== expected) {
			drift.push({ name, current, expected });
		}
	}

	if (drift.length === 0) {
		console.error(`[sync-sdk-pin] suite peerDeps in sync (${primaryHost})`);
		return;
	}

	console.error("[sync-sdk-pin] drift detected:");
	for (const item of drift) {
		console.error(`  ~ ${item.name}: ${item.current ?? "(missing)"} -> ${item.expected}`);
	}

	if (options.check) {
		// Non-zero exit when drift exists, for use in CI / pre-flight checks.
		process.exitCode = 3;
		return;
	}

	// Apply: rewrite the three peerDeps, preserving formatting (2-space indent +
	// trailing newline; verified byte-identical round-trip). Other peerDeps
	// (e.g. typebox) and all other top-level keys are left untouched.
	for (const item of drift) {
		peerDeps[item.name] = item.expected;
	}
	const updated = JSON.stringify(suite, null, 2) + "\n";
	if (updated === suiteRaw) {
		// Nothing changed after normalization (e.g. already canonical).
		console.error("[sync-sdk-pin] no byte-level change after rewrite");
		return;
	}
	writeFileSync(options.packagePath, updated);
	console.error(`[sync-sdk-pin] updated ${options.packagePath}`);
	console.error("[sync-sdk-pin] next: reinstall the suite so its lockfile/node_modules track the new version:");
	console.error("  cd external/pi-tools-suite && npm install --ignore-scripts");
}

main();
