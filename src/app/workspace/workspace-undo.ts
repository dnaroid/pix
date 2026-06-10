import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runProcess } from "../process.js";

export type WorkspaceUndoIndex = {
	version: 1;
	entries: Record<string, WorkspaceMutation[]>;
};

export type WorkspaceMutation = WorkspacePatchMutation | WorkspaceWriteMutation;

export type WorkspacePatchMutation = {
	type: "patch";
	patch: string;
	toolName?: string;
};

export type WorkspaceWriteMutation = {
	type: "write";
	path: string;
	beforeContent?: string;
	afterContent: string;
	toolName?: string;
};

export type WorkspaceMutationPreparation =
	| {
			type: "write";
			path: string;
			beforeContent?: string;
	  };

export type WorkspaceMutationFromToolInput = {
	cwd: string;
	toolName: string;
	args: unknown;
	details: unknown;
	isError: boolean;
	preparation?: WorkspaceMutationPreparation | undefined;
};

export type WorkspaceRevertResult =
	| { ok: true; changedFiles: number; revertedChanges: number }
	| { ok: false; error: string };

const UNDO_INDEX_VERSION = 1;

export function workspaceUndoIndexKey(_sessionFile: string | undefined, _sessionId: string, entryId: string): string {
	return entryId;
}

export function loadWorkspaceUndoIndex(agentDir: string): WorkspaceUndoIndex {
	try {
		const parsed: unknown = JSON.parse(readFileSync(workspaceUndoIndexPath(agentDir), "utf8"));
		return parseUndoIndex(parsed) ?? emptyUndoIndex();
	} catch {
		return emptyUndoIndex();
	}
}

export function saveWorkspaceUndoIndex(agentDir: string, index: WorkspaceUndoIndex): void {
	const path = workspaceUndoIndexPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export function prepareWorkspaceMutation(cwd: string, toolName: string, args: unknown): WorkspaceMutationPreparation | undefined {
	const name = normalizedToolName(toolName);
	if (name !== "write") return undefined;

	const record = plainRecord(args);
	const rawPath = toolPathValue(record);
	const afterContent = stringValue(record?.content);
	if (!rawPath || afterContent === undefined) return undefined;

	const safePath = safeRelativePath(cwd, rawPath);
	if (!safePath) return undefined;

	const absolutePath = resolve(cwd, safePath);
	return {
		type: "write",
		path: safePath,
		...(existsSync(absolutePath) ? { beforeContent: readFileSync(absolutePath, "utf8") } : {}),
	};
}

export function workspaceMutationFromToolExecution(input: WorkspaceMutationFromToolInput): WorkspaceMutation | undefined {
	if (input.isError) return undefined;

	const name = normalizedToolName(input.toolName);
	if (name === "write" && input.preparation?.type === "write") {
		const record = plainRecord(input.args);
		const rawPath = toolPathValue(record);
		const afterContent = stringValue(record?.content);
		if (!rawPath || afterContent === undefined || input.preparation.beforeContent === afterContent) return undefined;
		return {
			type: "write",
			path: input.preparation.path,
			...(input.preparation.beforeContent === undefined ? {} : { beforeContent: input.preparation.beforeContent }),
			afterContent,
			toolName: input.toolName,
		};
	}

	const patch = patchFromDetails(input.details) ?? patchFromArgs(input.args);
	if (!patch || !looksLikeUnifiedPatch(patch)) return undefined;

	if (name === "edit" || name === "apply_patch" || name === "ast_apply") {
		return { type: "patch", patch, toolName: input.toolName };
	}

	return undefined;
}

export async function revertWorkspaceMutations(cwd: string, mutations: readonly WorkspaceMutation[]): Promise<WorkspaceRevertResult> {
	const changedFiles = new Set<string>();
	const applied: WorkspaceMutation[] = [];

	for (const mutation of [...mutations].reverse()) {
		const result = await applyMutation(cwd, mutation, "undo");
		if (!result.ok) {
			const rollback = await rollbackMutations(cwd, applied);
			const rollbackText = rollback.ok ? "Rolled back already-applied undo steps." : `Rollback failed: ${rollback.error}`;
			return { ok: false, error: `${result.error}\n${rollbackText}` };
		}

		for (const file of result.changedFiles) changedFiles.add(file);
		applied.push(mutation);
	}

	return { ok: true, changedFiles: changedFiles.size, revertedChanges: applied.length };
}

async function rollbackMutations(cwd: string, appliedUndoMutations: readonly WorkspaceMutation[]): Promise<WorkspaceRevertResult> {
	for (const mutation of [...appliedUndoMutations].reverse()) {
		const result = await applyMutation(cwd, mutation, "redo");
		if (!result.ok) return { ok: false, error: result.error };
	}
	return { ok: true, changedFiles: 0, revertedChanges: appliedUndoMutations.length };
}

async function applyMutation(
	cwd: string,
	mutation: WorkspaceMutation,
	direction: "undo" | "redo",
): Promise<{ ok: true; changedFiles: string[] } | { ok: false; error: string }> {
	if (mutation.type === "patch") return applyPatchMutation(cwd, mutation, direction);
	return applyWriteMutation(cwd, mutation, direction);
}

async function applyPatchMutation(
	cwd: string,
	mutation: WorkspacePatchMutation,
	direction: "undo" | "redo",
): Promise<{ ok: true; changedFiles: string[] } | { ok: false; error: string }> {
	const args = ["apply", ...(direction === "undo" ? ["--reverse"] : []), "--whitespace=nowarn"];
	const check = await runGitApply(cwd, [...args, "--check"], mutation.patch);
	if (check.status !== 0) return { ok: false, error: commandError(`git ${args.join(" ")} --check`, check) };

	const apply = await runGitApply(cwd, args, mutation.patch);
	if (apply.status !== 0) return { ok: false, error: commandError(`git ${args.join(" ")}`, apply) };

	return { ok: true, changedFiles: filesFromPatch(mutation.patch) };
}

async function applyWriteMutation(
	cwd: string,
	mutation: WorkspaceWriteMutation,
	direction: "undo" | "redo",
): Promise<{ ok: true; changedFiles: string[] } | { ok: false; error: string }> {
	const safePath = safeRelativePath(cwd, mutation.path);
	if (!safePath) return { ok: false, error: `Refusing to modify path outside workspace: ${mutation.path}` };

	const absolutePath = resolve(cwd, safePath);
	const expectedContent = direction === "undo" ? mutation.afterContent : mutation.beforeContent;
	const nextContent = direction === "undo" ? mutation.beforeContent : mutation.afterContent;

	const currentExists = existsSync(absolutePath);
	const currentContent = currentExists ? await readFile(absolutePath, "utf8") : undefined;
	if (currentContent !== expectedContent) {
		return { ok: false, error: `Refusing to ${direction} write for ${safePath}: file content changed since the recorded command.` };
	}

	if (nextContent === undefined) {
		if (currentExists) await rm(absolutePath, { force: true });
	} else {
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, nextContent, "utf8");
	}

	return { ok: true, changedFiles: [safePath] };
}

function emptyUndoIndex(): WorkspaceUndoIndex {
	return { version: UNDO_INDEX_VERSION, entries: {} };
}

function parseUndoIndex(value: unknown): WorkspaceUndoIndex | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (record.version !== UNDO_INDEX_VERSION || !isMutationRecord(record.entries)) return undefined;
	return { version: UNDO_INDEX_VERSION, entries: record.entries };
}

function workspaceUndoIndexPath(agentDir: string): string {
	return join(agentDir, "pix", "workspace-undo", "index.json");
}

async function runGitApply(cwd: string, args: string[], input: string) {
	return runProcess("git", ["-c", "core.autocrlf=false", ...args], {
		cwd,
		input,
		maxBufferBytes: 20 * 1024 * 1024,
	});
}

function commandError(command: string, result: { error?: Error; status: number | null; stderr?: string; stdout?: string; timedOut?: boolean }): string {
	if (result.error) return `${command} failed: ${result.error.message}`;
	if (result.timedOut) return `${command} timed out`;
	const message = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status ?? "unknown"}`;
	return `${command} failed: ${message}`;
}

function normalizedToolName(toolName: string): string {
	return toolName.split(/[.:/]/).filter(Boolean).at(-1)?.trim().toLowerCase() ?? toolName.toLowerCase();
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function toolPathValue(record: Record<string, unknown> | undefined): string | undefined {
	return stringValue(record?.path) ?? stringValue(record?.file_path);
}

function patchFromDetails(details: unknown): string | undefined {
	const record = plainRecord(details);
	return stringValue(record?.patch) ?? stringValue(record?.diff);
}

function patchFromArgs(args: unknown): string | undefined {
	const record = plainRecord(args);
	return stringValue(record?.patch) ?? stringValue(record?.input);
}

function looksLikeUnifiedPatch(text: string): boolean {
	return /^---\s+/m.test(text) && /^\+\+\+\s+/m.test(text) && /^@@\s/m.test(text);
}

function filesFromPatch(patch: string): string[] {
	const files = new Set<string>();
	for (const line of patch.split("\n")) {
		const match = /^(?:---|\+\+\+)\s+(.+?)(?:\t.*)?$/.exec(line);
		const file = match?.[1]?.trim();
		if (!file || file === "/dev/null") continue;
		files.add(file.replace(/^[ab]\//, ""));
	}
	return [...files];
}

function safeRelativePath(cwd: string, inputPath: string): string | undefined {
	const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
	const relativePath = relative(resolve(cwd), absolutePath);
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return undefined;
	return relativePath;
}

function isMutationRecord(value: unknown): value is Record<string, WorkspaceMutation[]> {
	if (!value || typeof value !== "object") return false;
	return Object.values(value).every(isMutations);
}

function isMutations(value: unknown): value is WorkspaceMutation[] {
	return Array.isArray(value) && value.every(isMutation);
}

function isMutation(value: unknown): value is WorkspaceMutation {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.type === "patch") {
		return typeof record.patch === "string" && (record.toolName === undefined || typeof record.toolName === "string");
	}
	if (record.type === "write") {
		return (
			typeof record.path === "string" &&
			typeof record.afterContent === "string" &&
			(record.beforeContent === undefined || typeof record.beforeContent === "string") &&
			(record.toolName === undefined || typeof record.toolName === "string")
		);
	}
	return false;
}
