// Confined, atomic protocol storage for council runs.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_OUTPUT_DIR, normalizeOutputDir, PUBLISH_DIR } from "./config.mjs";

export const MAX_DOCUMENT_CHARS = 200_000;
const DOCUMENT_MODE = 0o644;
const LOCK_MODE = 0o600;

export class CouncilError extends Error {
	/** code 2 = usage/validation (state untouched), 1 = run marked incomplete. */
	constructor(message, code = 2) { super(message); this.code = code; }
}

export function assertBoundedText(value, label, max = MAX_DOCUMENT_CHARS) {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
		throw new CouncilError(`${label} must be non-empty text no longer than ${max} characters`);
	}
}

export function safeTopicSlug(topic) {
	const slug = topic.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56).replace(/-+$/g, "");
	return slug || "brainstorm";
}

/** Create (or reuse) a project-relative directory, refusing any symlinked segment. */
export async function ensureConfinedDirectory(cwd, relative) {
	let current = await realpath(cwd);
	for (const segment of normalizeOutputDir(relative).split("/")) {
		current = path.join(current, segment);
		await mkdir(current).catch((error) => { if (error.code !== "EEXIST") throw error; });
		if (await realpath(current) !== current) throw new CouncilError(`${path.relative(cwd, current) || segment} must not resolve through a symlink`);
	}
	return current;
}

/** Create (or reuse) a direct subdirectory of a run, refusing symlinks. */
export async function ensureRunSubdirectory(directory, name) {
	const target = path.join(directory, name);
	await mkdir(target).catch((error) => { if (error.code !== "EEXIST") throw error; });
	if (await realpath(target) !== target) throw new CouncilError(`${name}/ must not resolve through a symlink`, 1);
	return target;
}

export async function createRunDirectory(cwd, topic, id, outputDir = DEFAULT_OUTPUT_DIR) {
	const root = await ensureConfinedDirectory(cwd, outputDir);
	const day = new Date().toISOString().slice(0, 10);
	for (let attempt = 0; attempt < 5; attempt++) {
		const runDir = path.join(root, `${day}-${safeTopicSlug(topic)}${attempt ? `-${attempt}` : ""}-${id}`);
		try {
			await mkdir(runDir);
			return runDir;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
	}
	throw new CouncilError("Could not allocate a unique brainstorm directory");
}

export async function writeExclusive(file, content, mode = DOCUMENT_MODE) {
	const handle = await open(file, "wx", mode);
	try { await handle.writeFile(content, "utf8"); }
	finally { await handle.close(); }
}

export async function replaceDocument(file, content) {
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: DOCUMENT_MODE });
		await rename(temp, file);
	} finally {
		await rm(temp, { force: true });
	}
}

export async function writeJson(file, value) {
	await replaceDocument(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readDocument(directory, name) {
	const file = path.join(directory, name);
	if (await realpath(file) !== file) throw new CouncilError(`${name} must not be a symlink`);
	return readFile(file, "utf8");
}

/** Roots a continuation may address: configured output and the default root. */
export function runRoots(outputDir) {
	return [...new Set([outputDir ? normalizeOutputDir(outputDir) : DEFAULT_OUTPUT_DIR, DEFAULT_OUTPUT_DIR])];
}

export async function validatedRunPath(cwd, runDir, roots) {
	if (typeof runDir !== "string" || !runDir.trim()) throw new CouncilError("--run is required");
	const canonicalCwd = await realpath(cwd);
	const directory = await realpath(path.resolve(cwd, runDir)).catch(() => { throw new CouncilError(`Run directory not found: ${runDir}`); });
	let matched = false;
	for (const relative of roots) {
		const rootPath = path.join(canonicalCwd, relative);
		const actual = await realpath(rootPath).catch(() => undefined);
		if (actual === undefined) continue;
		if (actual !== rootPath) throw new CouncilError(`${relative} must not resolve through a symlink`);
		if (path.dirname(directory) === actual) { matched = true; break; }
	}
	if (!matched) throw new CouncilError(`Brainstorm run directory must be a direct child of ${roots.join(" or ")}`);
	const manifestPath = path.join(directory, "manifest.json");
	const actualManifest = await realpath(manifestPath).catch(() => { throw new CouncilError("Run has no manifest.json"); });
	if (actualManifest !== manifestPath) throw new CouncilError("Brainstorm manifest must not be a symlink");
	return { directory, manifestPath, cwd: canonicalCwd };
}

/** One exclusive lock per run for every mutating command. */
export async function withRunLock(directory, operation) {
	const lockPath = path.join(directory, ".council.lock");
	try {
		await writeExclusive(lockPath, "Council command in progress\n", LOCK_MODE);
	} catch (error) {
		if (error.code === "EEXIST") throw new CouncilError(`Another council command holds ${lockPath}; inspect and remove it only if that process crashed`);
		throw error;
	}
	try { return await operation(); }
	finally { await rm(lockPath, { force: true }); }
}

export { PUBLISH_DIR };
