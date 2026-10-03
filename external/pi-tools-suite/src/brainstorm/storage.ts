import { mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BRAINSTORM_PUBLISH_DIR, DEFAULT_BRAINSTORM_OUTPUT_DIR, normalizeOutputDir } from "./config.js";

export const MAX_DOCUMENT_CHARS = 200_000;
/** Council documents are ordinary project files; only the lock is private. */
export const DOCUMENT_MODE = 0o644;
export const LOCK_MODE = 0o600;

export function assertBoundedText(value: unknown, label: string, max = MAX_DOCUMENT_CHARS): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
		throw new Error(`${label} must be non-empty text no longer than ${max} characters`);
	}
}

export function safeTopicSlug(topic: string): string {
	const slug = topic.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56).replace(/-+$/g, "");
	return slug || "brainstorm";
}

/** Create (or reuse) a project-relative directory, refusing any symlinked segment. */
export async function ensureConfinedDirectory(cwd: string, relative: string): Promise<string> {
	let current = await realpath(cwd);
	for (const segment of normalizeOutputDir(relative).split("/")) {
		current = path.join(current, segment);
		await mkdir(current, { recursive: false }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
		if (await realpath(current) !== current) throw new Error(`${path.relative(cwd, current) || segment} must not resolve through a symlink`);
	}
	return current;
}

export async function createRunDirectory(cwd: string, topic: string, id: string, outputDir = DEFAULT_BRAINSTORM_OUTPUT_DIR): Promise<{ root: string; runDir: string }> {
	const root = await ensureConfinedDirectory(cwd, outputDir);
	const day = new Date().toISOString().slice(0, 10);
	for (let attempt = 0; attempt < 5; attempt++) {
		const name = `${day}-${safeTopicSlug(topic)}${attempt ? `-${attempt}` : ""}-${id}`;
		const runDir = path.join(root, name);
		try {
			await mkdir(runDir, { recursive: false });
			return { root, runDir };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new Error("Could not allocate a unique brainstorm directory");
}

export async function writeExclusive(file: string, content: string, mode = DOCUMENT_MODE): Promise<void> {
	const handle = await open(file, "wx", mode);
	try {
		await handle.writeFile(content, "utf8");
	} finally {
		await handle.close();
	}
}

export async function readJson<T>(file: string): Promise<T> {
	return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function replaceDocument(file: string, content: string): Promise<void> {
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: DOCUMENT_MODE });
		await rename(temp, file);
	} finally {
		await rm(temp, { force: true });
	}
}

export async function writeJson(file: string, value: unknown): Promise<void> {
	await replaceDocument(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Roots a continuation may address: configured output, the default and the legacy docs root. */
export function runRoots(outputDir?: string): string[] {
	return [...new Set([outputDir ? normalizeOutputDir(outputDir) : DEFAULT_BRAINSTORM_OUTPUT_DIR, DEFAULT_BRAINSTORM_OUTPUT_DIR, BRAINSTORM_PUBLISH_DIR])];
}

export async function validatedRunPath(cwd: string, runDir: string, roots: readonly string[] = runRoots()): Promise<{ root: string; directory: string; manifestPath: string }> {
	const canonicalCwd = await realpath(cwd);
	const directory = await realpath(path.resolve(cwd, runDir));
	let root: string | undefined;
	for (const relative of roots) {
		const rootPath = path.join(canonicalCwd, relative);
		const actual = await realpath(rootPath).catch(() => undefined);
		if (actual === undefined) continue;
		if (actual !== rootPath) throw new Error(`${relative} must not resolve through a symlink`);
		if (path.dirname(directory) === actual) { root = actual; break; }
	}
	if (!root) throw new Error(`Brainstorm run directory must be a direct child of ${roots.join(" or ")}`);
	const manifestPath = path.join(directory, "manifest.json");
	const actualManifest = await realpath(manifestPath);
	if (actualManifest !== manifestPath) throw new Error("Brainstorm manifest must not be a symlink");
	return { root, directory, manifestPath };
}
