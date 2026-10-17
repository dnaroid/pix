import * as fs from "node:fs";
import * as path from "node:path";

export function getRunRoot(cwd: string): string {
	return path.join(cwd, ".pi", "subagents");
}

export function createRunDir(cwd: string, slug?: string): string {
	if (slug) validateBasename(slug, "slug");
	const runRoot = getRunRoot(cwd);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const baseName = `${timestamp}${slug ? `-${slug}` : ""}`;
	let runDir = path.join(runRoot, baseName);
	let suffix = 2;
	while (fs.existsSync(runDir)) {
		runDir = path.join(runRoot, `${baseName}-${suffix}`);
		suffix++;
	}
	fs.mkdirSync(path.join(runDir, "prompts"), { recursive: true });
	return runDir;
}

/**
 * Parent session ids are UUIDs. Legacy run directories are timestamp-named, so
 * the two kinds of `.pi/subagents/` children never collide (decision 0072).
 */
export const PARENT_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Timestamped batch label `YYYY-MM-DDTHH-MM-SS[-slug]` (no directory is created). */
export function batchBaseName(slug?: string, now = new Date()): string {
	if (slug) validateBasename(slug, "slug");
	const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
	return `${timestamp}${slug ? `-${slug}` : ""}`;
}

/**
 * Run key of one batch: `<cwd>/.pi/subagents/<scope>/<batch>`. It is an
 * identity string, not a directory — only child sessions (`<scope>/*.jsonl`)
 * and owned-launch records (`<scope>/owned/<batch>/<agentId>/`) exist on disk.
 */
export function runKey(cwd: string, scope: string, batch: string): string {
	return path.join(getRunRoot(cwd), scope, batch);
}

export interface ParsedRunKey { root: string; cwd: string; scope: string; batch: string }

/** Parse a run key; undefined for legacy run directories and foreign paths. */
export function parseRunKey(key: string): ParsedRunKey | undefined {
	const resolved = path.resolve(key);
	const batch = path.basename(resolved);
	const scopeDir = path.dirname(resolved);
	const scope = path.basename(scopeDir);
	const root = path.dirname(scopeDir);
	if (!PARENT_SESSION_ID_PATTERN.test(scope) || path.basename(root) !== "subagents" || path.basename(path.dirname(root)) !== ".pi") return undefined;
	if (!SAFE_BASENAME.test(batch) || batch.includes("..")) return undefined;
	return { root, cwd: path.dirname(path.dirname(root)), scope, batch };
}

/** Parent-scoped child-session directory `<cwd>/.pi/subagents/<scope>/`. */
export function scopeDir(cwd: string, scope: string): string {
	return path.join(getRunRoot(cwd), scope);
}

/** Owned-launch base of one agent (the only per-agent directory, created only for owned launches). */
export function ownedAgentDir(runDir: string, agentId: string): string {
	const parsed = parseRunKey(runDir);
	if (!parsed) return path.join(runDir, agentId);
	return path.join(parsed.root, parsed.scope, "owned", parsed.batch, agentId);
}

/** Owned root of a batch: `<scope>/owned/<batch>/`. */
export function ownedBatchDir(runDir: string): string {
	const parsed = parseRunKey(runDir);
	return parsed ? path.join(parsed.root, parsed.scope, "owned", parsed.batch) : runDir;
}

export function resolveRunDir(cwd: string, runDir: string): string {
	if (path.isAbsolute(runDir)) return runDir;
	return path.resolve(cwd, runDir);
}

export function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function hasLaunchedAgentPrompt(runDir: string, agentId: string): boolean {
	return fs.existsSync(path.join(runDir, agentId, "prompt.md"));
}

export function hasQueuedAgentPrompt(runDir: string, agentId: string): boolean {
	return fs.existsSync(path.join(runDir, "prompts", `${agentId}.md`));
}

export function hasAgentPrompt(runDir: string, agentId: string): boolean {
	return hasLaunchedAgentPrompt(runDir, agentId) || hasQueuedAgentPrompt(runDir, agentId);
}

const SAFE_BASENAME = /^[A-Za-z0-9._-]+$/;

export function validateBasename(value: string, label: string): void {
	if (!SAFE_BASENAME.test(value)) {
		throw new Error(
			`Invalid ${label}: "${value}". Must match ${SAFE_BASENAME.source}`,
		);
	}
	if (value.includes("..")) {
		throw new Error(`Invalid ${label}: "${value}". Must not contain ".."`);
	}
}
