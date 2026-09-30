#!/usr/bin/env node
// Disable only the obsolete provider resources, never uninstall their files.
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";

const PACKAGE = /^npm:pi-claude-code-provider(?:@[^/\s]+)?$/;
const LEGACY_PATH = /(?:^|[/\\])pi-claude-code-provider(?:[/\\]extensions(?:[/\\](?:index|pi-claude-code-provider)\.[cm]?[jt]s)?)?[/\\]?$/;

/** Pure, narrow migration: preserve all unrelated settings and package filters. */
export function migrateProviderSettings(text) {
	const errors = [];
	const settings = parse(text, errors, { allowTrailingComma: true });
	if (errors.length || !settings || typeof settings !== "object" || Array.isArray(settings)) {
		throw new Error("Invalid settings document; refusing to modify it");
	}
	let result = text;
	if (Array.isArray(settings.packages)) {
		settings.packages.forEach((pkg, index) => {
			const source = typeof pkg === "string" ? pkg : pkg?.source;
			if (typeof source !== "string" || !PACKAGE.test(source)) return;
			if (typeof pkg === "object" && Array.isArray(pkg.extensions) && pkg.extensions.length === 0) return;
			result = applyEdits(result, modify(result, ["packages", index],
				{ ...(typeof pkg === "object" ? pkg : { source }), extensions: [] },
				{ formattingOptions: { insertSpaces: true, tabSize: 2 } }));
		});
	}
	if (Array.isArray(settings.extensions)) {
		const extensions = settings.extensions.filter((entry) => typeof entry !== "string" || !LEGACY_PATH.test(entry));
		if (extensions.length !== settings.extensions.length) {
			result = applyEdits(result, modify(result, ["extensions"], extensions,
				{ formattingOptions: { insertSpaces: true, tabSize: 2 } }));
		}
	}
	return result;
}

export async function migrateSettingsFile(file, check = false) {
	const info = await lstat(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
	if (!info) return false;
	if (!info.isFile()) throw new Error("Settings must be a regular file (symlinks are not modified)");
	const lock = `${file}.claude-provider-migration.lock`;
	const handle = await open(lock, "wx", 0o600);
	const temporary = `${file}.claude-provider-${process.pid}.tmp`;
	try {
		await handle.writeFile(String(process.pid));
		const before = await readFile(file, "utf8");
		const after = migrateProviderSettings(before);
		if (after === before) return false;
		if (check) return true;
		const output = await open(temporary, "wx", info.mode & 0o777);
		try { await output.writeFile(after); await output.sync(); } finally { await output.close(); }
		if (await readFile(file, "utf8") !== before) throw new Error("Settings changed concurrently; retry migration");
		await rename(temporary, file);
		return true;
	} finally {
		await handle.close();
		await rm(temporary, { force: true });
		await rm(lock, { force: true });
	}
}

async function main() {
	let agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	let projectSettings;
	let check = false;
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--check") check = true;
		else if (args[i] === "--agent-dir" && args[i + 1]) agentDir = resolve(args[++i]);
		else if (args[i] === "--project-settings" && args[i + 1]) projectSettings = resolve(args[++i]);
		else throw new Error("Usage: migrate-claude-provider [--check] [--agent-dir DIR] [--project-settings FILE]");
	}
	// Never discover project configuration automatically or inspect auth/models files.
	for (const file of [join(agentDir, "settings.json"), projectSettings].filter(Boolean)) {
		const changed = await migrateSettingsFile(file, check);
		console.log(`${file}: ${changed ? check ? "migration required" : "legacy provider disabled" : "current"}`);
		if (check && changed) process.exitCode = 3;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
