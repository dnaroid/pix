import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RegistryExecutor } from "./context.js";
import { runGit } from "./git.js";
import { MAX_FILE_BYTES, MAX_RENDER_FILE_BYTES, MAX_RENDER_LINES, collectFilePaths, type RegistryDiffFile } from "./diff.js";

/** Conflict-marker labels written by `git merge-file`; also used to detect unresolved files. */
const LOCAL_LABEL = "local";
const REGISTRY_LABEL = "registry";
const LOCAL_MARKER = new RegExp(`^<{7} ${LOCAL_LABEL}\\r?$`, "m");
const REGISTRY_MARKER = new RegExp(`^>{7} ${REGISTRY_LABEL}\\r?$`, "m");

/** Guidance shared by every refusal that leaves a diverged copy untouched. */
export const DIVERGED_GUIDANCE = "Run Merge to combine both copies, or choose Mark as merged if the local copy already includes the registry changes.";

/** One file the merge would change in the project copy. */
export type MergeFileChange = {
	readonly path: string;
	/** Current project bytes; undefined when the file is absent locally. */
	readonly ours: Buffer | undefined;
	/** Clean result; undefined deletes the file. Unset for conflicts. */
	readonly merged?: Buffer | undefined;
	readonly conflict?: {
		readonly reason: string;
		/** Text with conflict markers; absent for binary/oversized/delete conflicts. */
		readonly markers?: Buffer;
	};
};

export type TreeMergeResult = {
	readonly changes: readonly MergeFileChange[];
	readonly conflicts: readonly MergeFileChange[];
};

export type TreeMergeRoots = {
	/** Resource-relative roots (a skill tree, an agent file plus companion, a plans tree…). */
	readonly roots: readonly string[];
	readonly base: string;
	readonly ours: string;
	readonly theirs: string;
	readonly acceptFile?: (name: string) => boolean;
};

export async function withMergeWorkspace<T>(operation: (directory: string) => Promise<T>): Promise<T> {
	const directory = await fs.mkdtemp(join(tmpdir(), "pix-registry-merge-"));
	try {
		return await operation(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

/**
 * Check out registry `paths` as of `revision` into `destination` without
 * touching the cache index, HEAD or working tree. Paths absent at the revision
 * are skipped; an unknown revision is a broken baseline, never silently empty.
 */
export async function materializeRevision(
	executor: RegistryExecutor,
	cacheDir: string,
	revision: string,
	paths: readonly string[],
	destination: string,
): Promise<void> {
	if (!/^[0-9a-f]{7,64}$/i.test(revision)
		|| (await runGit(executor, cacheDir, ["cat-file", "-e", `${revision}^{commit}`], { allowFailure: true })).code !== 0) {
		throw new Error(`Baseline revision ${revision.slice(0, 8)} is not in the registry history, so a merge base cannot be reconstructed. Review Compare and choose Mark as merged if the local copy already includes the registry changes.`);
	}
	await fs.mkdir(destination, { recursive: true });
	const listed = (await runGit(executor, cacheDir, ["ls-tree", "--name-only", revision, "--", ...paths])).stdout
		.split("\n").map((line) => line.trim()).filter(Boolean);
	if (listed.length === 0) return;
	await runGit(executor, cacheDir, ["--work-tree", destination, "restore", "--source", revision, "--worktree", "--", ...listed]);
}

async function readSide(root: string, rel: string): Promise<Buffer | undefined> {
	const path = join(root, ...rel.split("/"));
	let stat: import("node:fs").Stats;
	try { stat = await fs.lstat(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (stat.isSymbolicLink()) throw new Error(`Registry merge cannot read symbolic links: ${rel}`);
	if (!stat.isFile()) throw new Error(`Registry merge entry is not a regular file: ${rel}`);
	return fs.readFile(path);
}

function same(left: Buffer | undefined, right: Buffer | undefined): boolean {
	return left === undefined || right === undefined ? left === right : left.equals(right);
}

function textOf(content: Buffer): string | undefined {
	if (content.length > MAX_FILE_BYTES || content.includes(0)) return undefined;
	try { return new TextDecoder("utf-8", { fatal: true }).decode(content); }
	catch { return undefined; }
}

async function mergeText(executor: RegistryExecutor, work: string, ours: Buffer, base: Buffer, theirs: Buffer): Promise<{ text: string; clean: boolean }> {
	const directory = join(work, randomUUID());
	await fs.mkdir(directory, { recursive: true });
	const files = { ours: join(directory, "ours"), base: join(directory, "base"), theirs: join(directory, "theirs") };
	await Promise.all([fs.writeFile(files.ours, ours), fs.writeFile(files.base, base), fs.writeFile(files.theirs, theirs)]);
	const result = await runGit(executor, directory, [
		"merge-file", "-p", "-L", LOCAL_LABEL, "-L", "base", "-L", REGISTRY_LABEL, files.ours, files.base, files.theirs,
	], { allowFailure: true });
	// Exit status is the conflict count (capped at 127); larger/negative values are errors.
	if (result.code < 0 || result.code > 127) throw new Error(result.stderr.trim() || `git merge-file failed with exit code ${result.code}`);
	return { text: result.stdout, clean: result.code === 0 };
}

/**
 * Three-way merge of resource trees: one-sided edits, additions and deletions
 * apply automatically; files edited on both sides merge line by line. Binary,
 * oversized and edit/delete files changed on both sides are conflicts.
 * Pure: nothing outside `work` is written.
 */
export async function mergeTrees(executor: RegistryExecutor, input: TreeMergeRoots, work: string): Promise<TreeMergeResult> {
	const paths = new Set<string>();
	for (const root of input.roots) {
		for (const base of [input.base, input.ours, input.theirs]) await collectFilePaths(base, root, paths, input.acceptFile);
	}
	const changes: MergeFileChange[] = [];
	const conflicts: MergeFileChange[] = [];
	for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
		const [base, ours, theirs] = await Promise.all([readSide(input.base, path), readSide(input.ours, path), readSide(input.theirs, path)]);
		if (same(ours, theirs) || same(theirs, base)) continue;
		if (same(ours, base)) {
			changes.push({ path, ours, merged: theirs });
			continue;
		}
		let conflict: MergeFileChange["conflict"];
		if (!ours || !theirs) {
			conflict = { reason: ours ? "deleted in the registry but changed locally" : "deleted locally but changed in the registry" };
		} else if (textOf(ours) === undefined || textOf(theirs) === undefined || (base && textOf(base) === undefined)) {
			conflict = { reason: "binary or oversized file changed on both sides" };
		} else {
			const merged = await mergeText(executor, work, ours, base ?? Buffer.alloc(0), theirs);
			if (merged.clean) {
				changes.push({ path, ours, merged: Buffer.from(merged.text, "utf8") });
				continue;
			}
			conflict = { reason: "the same lines changed on both sides", markers: Buffer.from(merged.text, "utf8") };
		}
		const change: MergeFileChange = { path, ours, conflict };
		changes.push(change);
		conflicts.push(change);
	}
	return { changes, conflicts };
}

/** Write clean changes, and conflict markers only when explicitly requested. */
export async function applyTreeMerge(root: string, changes: readonly MergeFileChange[], writeMarkers: boolean): Promise<void> {
	for (const change of changes) {
		if (change.conflict && !(writeMarkers && change.conflict.markers)) continue;
		const content = change.conflict ? change.conflict.markers : change.merged;
		const target = join(root, ...change.path.split("/"));
		if (content === undefined) {
			await fs.rm(target, { force: true });
			continue;
		}
		await fs.mkdir(dirname(target), { recursive: true });
		const staged = join(dirname(target), `.registry-merge-${randomUUID()}.tmp`);
		try {
			await fs.writeFile(staged, content, { flag: "wx" });
			await fs.rename(staged, target);
		} finally {
			await fs.rm(staged, { force: true });
		}
	}
}

export function conflictSummary(conflicts: readonly MergeFileChange[]): string {
	const listed = conflicts.slice(0, 5).map((change) => `${change.path} (${change.conflict?.reason})`).join(", ");
	return conflicts.length > 5 ? `${listed}, and ${conflicts.length - 5} more` : listed;
}

/** Refuse to adopt a baseline while files still contain this merge's conflict markers. */
export async function assertNoConflictMarkers(root: string, roots: readonly string[], acceptFile?: (name: string) => boolean): Promise<void> {
	const paths = new Set<string>();
	for (const rel of roots) await collectFilePaths(root, rel, paths, acceptFile);
	const unresolved: string[] = [];
	for (const path of [...paths].sort()) {
		const content = await readSide(root, path);
		const text = content && textOf(content);
		if (text && LOCAL_MARKER.test(text) && REGISTRY_MARKER.test(text)) unresolved.push(path);
	}
	if (unresolved.length > 0) {
		throw new Error(`Unresolved merge conflict markers remain in ${unresolved.join(", ")}. Resolve them before choosing Mark as merged.`);
	}
}

function lineCount(text: string): number {
	let count = 1;
	for (let index = text.indexOf("\n"); index >= 0 && count <= MAX_RENDER_LINES; index = text.indexOf("\n", index + 1)) count++;
	return count;
}

/** Preview rows: old side = current project copy, new side = merge result. */
export function mergePreviewFiles(changes: readonly MergeFileChange[]): RegistryDiffFile[] {
	return changes.map((change): RegistryDiffFile => {
		const result = change.conflict ? change.conflict.markers : change.merged;
		const oldText = change.ours ? textOf(change.ours) ?? null : null;
		const newText = result ? textOf(result) ?? null : null;
		const nonText = (change.ours && oldText === null) || (result && newText === null);
		const tooLarge = Buffer.byteLength(oldText ?? "") + Buffer.byteLength(newText ?? "") > MAX_RENDER_FILE_BYTES
			|| lineCount(oldText ?? "") + lineCount(newText ?? "") > MAX_RENDER_LINES;
		const notices = [
			...(change.conflict ? [`Conflict: ${change.conflict.reason}`] : []),
			...(nonText ? ["Binary or oversized file"] : tooLarge ? [`Diff exceeds the ${MAX_RENDER_FILE_BYTES} byte or ${MAX_RENDER_LINES} line display limit`] : []),
		];
		const hideText = nonText || tooLarge || (change.conflict && !change.conflict.markers);
		return {
			path: change.path,
			oldText: hideText ? null : oldText,
			newText: hideText ? null : newText,
			...(hideText && notices.length > 0 ? { notice: notices.join("; ") } : {}),
			...(change.conflict ? { conflict: true } : {}),
		};
	});
}
