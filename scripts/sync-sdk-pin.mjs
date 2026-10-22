#!/usr/bin/env node
// Keep `@earendil-works/*` pins of in-repo SDK consumers aligned with the host
// pi SDK version declared in the root package.json:
//   - bundled `pi-tools-suite` extension peerDependencies (all SDK packages required);
//   - `acp/package.json` dependencies (only the SDK packages it declares).
//
// Problem this solves: the extension runs inside the pi host process, so its
// peerDeps must match the installed host SDK exactly. With loose peer ranges
// (e.g. "*") npm could resolve a stale copy in the suite's own node_modules,
// causing a double-load mine (e.g. 0.75.4 in the suite vs 0.79.4 in the host).
// This script pins and verifies the alignment, following the same convention as
// scripts/sync-pi-tools-suite.mjs (default = apply, --check = report drift).
//
// Usage:
//   node scripts/sync-sdk-pin.mjs               # rewrite consumer pins to host version
//   node scripts/sync-sdk-pin.mjs --check       # report drift only, no writes (non-zero exit)
//   node scripts/sync-sdk-pin.mjs --host 0.79.4 # force a specific host version
//   node scripts/sync-sdk-pin.mjs --root <path> # root package.json dir (default: repo root)
//   node scripts/sync-sdk-pin.mjs --package <path> # suite package.json (default: external/pi-tools-suite)
//   node scripts/sync-sdk-pin.mjs --acp <path>     # ACP package.json (default: acp/package.json)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const DEFAULT_ROOT_DIR = REPO_ROOT;
const DEFAULT_PACKAGE = resolve(REPO_ROOT, "external", "pi-tools-suite", "package.json");
const DEFAULT_ACP_PACKAGE = resolve(REPO_ROOT, "acp", "package.json");

// Packages whose suite peerDeps must track the host SDK version. They are pinned
// together in the root package.json; typebox is intentionally NOT synced.
const SYNC_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

function parseArgs(argv) {
	const options = { check: false, host: undefined, rootDir: DEFAULT_ROOT_DIR, packagePath: DEFAULT_PACKAGE, acpPath: DEFAULT_ACP_PACKAGE };
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
		} else if (arg === "--acp") {
			options.acpPath = resolve(argv[++index] ?? "");
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
	console.error("Usage: sync-sdk-pin [--check] [--host <version>] [--root <dir>] [--package <path>] [--acp <path>]");
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

// Rewrite one pin in place, preserving the file's own formatting (the suite
// uses 2-space indent, ACP uses tabs). Only the value inside the named section
// object is replaced.
function replacePin(raw, section, name, expected) {
	const sectionIndex = raw.indexOf(`"${section}"`);
	if (sectionIndex < 0) throw new Error(`section ${section} not found`);
	const end = raw.indexOf("}", sectionIndex);
	const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const pattern = new RegExp(`("${escaped}"\\s*:\\s*)"[^"]*"`);
	const body = raw.slice(sectionIndex, end);
	if (!pattern.test(body)) throw new Error(`${name} not found in ${section}`);
	return raw.slice(0, sectionIndex) + body.replace(pattern, `$1"${expected}"`) + raw.slice(end);
}

// Each target lists a package.json, the section holding SDK pins, and whether
// every SDK package must be present there (suite) or only declared ones (ACP).
function syncTargets(options) {
	return [
		{ label: "suite peerDeps", path: options.packagePath, section: "peerDependencies", requireAll: true,
			reinstall: "cd external/pi-tools-suite && npm install --ignore-scripts" },
		{ label: "acp deps", path: options.acpPath, section: "dependencies", requireAll: false,
			reinstall: "cd acp && npm install" },
	];
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

	let failed = false;
	let drifted = false;
	for (const target of syncTargets(options)) {
		const raw = readFileSync(target.path, "utf8");
		const pins = JSON.parse(raw)[target.section];
		if (!pins || typeof pins !== "object") {
			console.error(`[sync-sdk-pin] no ${target.section} found in ${target.path}`);
			failed = true;
			continue;
		}

		const drift = []; // { name, current, expected }
		for (const name of SYNC_PACKAGES) {
			const current = pins[name];
			if (current === undefined) {
				if (target.requireAll) {
					console.error(`[sync-sdk-pin] ERROR: ${name} missing from ${target.label} (${target.path})`);
					failed = true;
				}
				continue;
			}
			if (current !== hostVersions[name]) drift.push({ name, current, expected: hostVersions[name] });
		}

		if (drift.length === 0) {
			console.error(`[sync-sdk-pin] ${target.label} in sync (${primaryHost})`);
			continue;
		}
		drifted = true;
		console.error(`[sync-sdk-pin] ${target.label} drift detected (${target.path}):`);
		for (const item of drift) console.error(`  ~ ${item.name}: ${item.current} -> ${item.expected}`);
		if (options.check) continue;

		let updated = raw;
		for (const item of drift) updated = replacePin(updated, target.section, item.name, item.expected);
		JSON.parse(updated); // guard: never write invalid JSON
		writeFileSync(target.path, updated);
		console.error(`[sync-sdk-pin] updated ${target.path}`);
		console.error(`[sync-sdk-pin] next: reinstall so its lockfile/node_modules track the new version:\n  ${target.reinstall}`);
	}

	if (failed) process.exitCode = 1;
	// Non-zero exit when drift exists, for use in CI / pre-flight checks.
	else if (options.check && drifted) process.exitCode = 3;
}

main();
