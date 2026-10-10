import { promises as fs } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalRegistryEntryName } from "./model.js";

/** Structured Desktop channel carrying on-demand Registry resource diffs. */


/** Per-file ceiling; larger files are reported as a notice instead of text. */
const MAX_FILE_BYTES = 1_000_000;
/** Whole-response ceiling across every changed file's old/new texts. */
const MAX_TOTAL_BYTES = 2_000_000;
/** Bound synchronous sidebar diff construction and DOM rows, not just transport bytes. */
const MAX_RENDER_FILE_BYTES = 128_000;
const MAX_RENDER_LINES = 2_000;
const MAX_TOTAL_RENDER_LINES = 5_000;

function lineCountThrough(text: string, limit: number): number {
	let count = 1;
	for (let index = 0; count <= limit; index++) {
		index = text.indexOf("\n", index);
		if (index < 0) break;
		count++;
	}
	return count;
}

export interface RegistryDiffFile {
	readonly path: string;
	readonly oldText: string | null;
	readonly newText: string | null;
	readonly notice?: string;
}

/** Payload published on {@link REGISTRY_DIFF_EVENT}; `error` marks a failed diff. */
export interface RegistryDiffPayload {
	readonly version: 1;
	readonly files: readonly RegistryDiffFile[];
	readonly type?: string;
	readonly name?: string;
	readonly error?: string;
}

type FileRead = { kind: "absent" } | { kind: "text"; text: string } | { kind: "notice"; notice: string; digest: string };

async function digestFile(path: string): Promise<string> {
	const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		if (!(await handle.stat()).isFile()) throw new Error(`Registry diff entry is not a regular file: ${path}`);
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let position = 0;
		while (true) {
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
			if (bytesRead === 0) break;
			hash.update(chunk.subarray(0, bytesRead));
			position += bytesRead;
		}
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

async function lstatIfExists(path: string): Promise<import("node:fs").Stats | undefined> {
	try {
		return await fs.lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Recursively collect regular-file paths (relative to `base`) under `rel`. */
async function collectFilePaths(base: string, rel: string, out: Set<string>): Promise<void> {
	const stat = await lstatIfExists(join(base, rel));
	if (!stat) return;
	if (stat.isSymbolicLink()) throw new Error(`Registry diff cannot traverse symbolic links: ${rel}`);
	if (stat.isFile()) {
		out.add(rel);
		return;
	}
	if (!stat.isDirectory()) throw new Error(`Unsupported registry diff entry: ${rel}`);
	const entries = (await fs.readdir(join(base, rel), { withFileTypes: true }))
		.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		if (!canonicalRegistryEntryName(entry.name)) continue;
		await collectFilePaths(base, rel === "" ? entry.name : `${rel}/${entry.name}`, out);
	}
}

async function readFileSide(base: string, rel: string, label: string): Promise<FileRead> {
	const stat = await lstatIfExists(join(base, rel));
	if (!stat) return { kind: "absent" };
	if (stat.isSymbolicLink()) throw new Error(`Registry diff cannot read symbolic links: ${rel}`);
	if (!stat.isFile()) throw new Error(`Registry diff entry is not a regular file: ${rel}`);
	if (stat.size > MAX_FILE_BYTES) {
		return { kind: "notice", notice: `${label} exceeds the ${MAX_FILE_BYTES} byte per-file diff limit`, digest: await digestFile(join(base, rel)) };
	}
	const content = await fs.readFile(join(base, rel));
	if (content.length > MAX_FILE_BYTES) {
		return { kind: "notice", notice: `${label} exceeds the ${MAX_FILE_BYTES} byte per-file diff limit`, digest: createHash("sha256").update(content).digest("hex") };
	}
	let text: string;
	try {
		if (content.includes(0)) throw new Error("binary");
		text = new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch {
		return { kind: "notice", notice: `${label} is binary`, digest: createHash("sha256").update(content).digest("hex") };
	}
	return { kind: "text", text };
}

/**
 * Compare two resource copies and return only the changed files.
 *
 * `oldBase` is the registry's cached copy, `newBase` the project-local copy,
 * and `roots` the resource-relative file/directory roots to compare (a skill
 * tree, or an agent file plus its optional companion directory). A null text
 * means the file is absent on that side; a notice replaces both texts for
 * binary or oversized files so nontext content is never silently skipped.
 * Symbolic links and other non-regular entries are rejected, never followed.
 */
export async function collectRegistryFileDiff(
	oldBase: string,
	newBase: string,
	roots: readonly string[],
): Promise<RegistryDiffFile[]> {
	const oldFiles = new Set<string>();
	const newFiles = new Set<string>();
	for (const root of roots) {
		await collectFilePaths(oldBase, root, oldFiles);
		await collectFilePaths(newBase, root, newFiles);
	}

	const files: RegistryDiffFile[] = [];
	let budget = MAX_TOTAL_BYTES;
	let lineBudget = MAX_TOTAL_RENDER_LINES;
	for (const rel of [...new Set([...oldFiles, ...newFiles])].sort((left, right) => left.localeCompare(right))) {
		const oldRead = await readFileSide(oldBase, rel, "Registry copy");
		const newRead = await readFileSide(newBase, rel, "Project copy");
		if (oldRead.kind === "text" && newRead.kind === "text" && oldRead.text === newRead.text) continue;
		if (oldRead.kind === "notice" && newRead.kind === "notice" && oldRead.digest === newRead.digest) continue;

		const notices: string[] = [];
		if (oldRead.kind === "notice") notices.push(oldRead.notice);
		if (newRead.kind === "notice") notices.push(newRead.notice);
		let oldText = oldRead.kind === "text" ? oldRead.text : null;
		let newText = newRead.kind === "text" ? newRead.text : null;
		if (notices.length === 0) {
			const size = Buffer.byteLength(oldText ?? "", "utf8") + Buffer.byteLength(newText ?? "", "utf8");
			const lineCount = lineCountThrough(oldText ?? "", MAX_RENDER_LINES) + lineCountThrough(newText ?? "", MAX_RENDER_LINES);
			if (size > MAX_RENDER_FILE_BYTES || lineCount > MAX_RENDER_LINES) {
				notices.push(`Diff exceeds the ${MAX_RENDER_FILE_BYTES} byte or ${MAX_RENDER_LINES} line display limit`);
			} else if (size > budget || lineCount > lineBudget) {
				notices.push(`Diff payload exceeds the ${MAX_TOTAL_BYTES} byte or ${MAX_TOTAL_RENDER_LINES} line display limit`);
			} else {
				budget -= size;
				lineBudget -= lineCount;
			}
		}
		if (notices.length > 0) {
			oldText = null;
			newText = null;
		}
		files.push({
			path: rel,
			oldText,
			newText,
			...(notices.length > 0 ? { notice: notices.join("; ") } : {}),
		});
	}
	return files;
}
