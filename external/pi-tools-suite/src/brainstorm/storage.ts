import { mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrainstormManifest } from "./workflow.js";

export const MAX_DOCUMENT_CHARS = 200_000;

export function assertBoundedText(value: unknown, label: string, max = MAX_DOCUMENT_CHARS): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
		throw new Error(`${label} must be non-empty text no longer than ${max} characters`);
	}
}

export function safeTopicSlug(topic: string): string {
	const slug = topic.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56).replace(/-+$/g, "");
	return slug || "brainstorm";
}

export async function createRunDirectory(cwd: string, topic: string, id: string): Promise<{ root: string; runDir: string }> {
	const canonicalCwd = await realpath(cwd);
	const docs = path.join(canonicalCwd, "docs");
	await mkdir(docs, { recursive: true });
	if (await realpath(docs) !== docs) throw new Error("docs must not resolve through a symlink");
	const brainstorms = path.join(docs, "brainstorms");
	await mkdir(brainstorms, { recursive: true });
	const root = await realpath(brainstorms);
	if (root !== brainstorms) throw new Error("docs/brainstorms must not resolve through a symlink");
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

export async function writeExclusive(file: string, content: string): Promise<void> {
	const handle = await open(file, "wx", 0o600);
	try {
		await handle.writeFile(content, "utf8");
	} finally {
		await handle.close();
	}
}

export async function readManifest(file: string): Promise<BrainstormManifest> {
	return JSON.parse(await readFile(file, "utf8")) as BrainstormManifest;
}

export async function replaceDocument(file: string, content: string): Promise<void> {
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(temp, file);
	} finally {
		await rm(temp, { force: true });
	}
}

export async function writeManifest(file: string, manifest: BrainstormManifest): Promise<void> {
	await replaceDocument(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function validatedRunPath(cwd: string, runDir: string): Promise<{ root: string; directory: string; manifestPath: string }> {
	const rootPath = path.join(await realpath(cwd), "docs/brainstorms");
	const root = await realpath(rootPath);
	if (root !== rootPath) throw new Error("docs/brainstorms must not resolve through a symlink");
	const directory = await realpath(path.resolve(cwd, runDir));
	if (path.dirname(directory) !== root) throw new Error("Brainstorm run directory must be a direct child of docs/brainstorms");
	const manifestPath = path.join(directory, "manifest.json");
	const actualManifest = await realpath(manifestPath);
	if (actualManifest !== manifestPath) throw new Error("Brainstorm manifest must not be a symlink");
	return { root, directory, manifestPath };
}
