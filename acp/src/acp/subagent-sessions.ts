/**
 * Read-only Desktop viewers for async-subagent sessions.
 *
 * A sub-agent JSONL is owned by its parent (spawn/send). Desktop never opens it
 * through a Pi runtime because loading, migrations, session_start handlers and
 * metadata writes can append to the file. Viewers read persisted history only;
 * "continue in a new session" forks from a truncated snapshot copy.
 *
 * Session-native layout (decision 0072): a run key is
 * `<cwd>/.pi/subagents/<scope>/<batch>` (identity only, not a directory). The
 * child JSONL sits directly in `<scope>/` and names itself with a
 * `subagent_meta` entry; its status lives in `pi-tools-suite:subagent` entries
 * of the parent session. Legacy `<run>/<agent>/session_file` links remain
 * readable so old transcripts stay viewable until they age out.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const ERROR_INVALID_PARAMS = -32602;
const ERROR_SERVER = -32603;
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEADER_READ_LIMIT = 64 * 1024;

import type {
	DesktopSubagentOpenSessionRequest,
	SubagentSessionLink,
	SubagentSessionState,
} from "./subagent-sessions-contract.js";

export * from "./subagent-sessions-contract.js";

/** Child entry naming its agent/batch (written by the child, `core/subagent-meta.ts`). */
const SUBAGENT_META_ENTRY = "subagent_meta";
/** Parent-authored lifecycle record entry (`core/store.ts`). */
const SUBAGENT_RECORD_ENTRY = "pi-tools-suite:subagent";
const SAFE_BATCH = /^[A-Za-z0-9._-]+$/;
const TERMINAL_STATUSES = new Set(["done", "failed", "stopped"]);
const META_CACHE_LIMIT = 256;
const PARENT_CACHE_LIMIT = 16;
const PARENT_READ_CHUNK = 1024 * 1024;

export interface ResolvedLegacySubagentSession {
	readonly kind: "legacy";
	readonly runDir: string;
	readonly agentId: string;
	readonly agentDir: string;
	readonly sessionFile: string;
}

export interface ResolvedScopedSubagentSession {
	readonly kind: "scoped";
	/** Canonical run key `<real project>/.pi/subagents/<scope>/<batch>`. */
	readonly runDir: string;
	readonly agentId: string;
	readonly scope: string;
	readonly batch: string;
	readonly scopeDir: string;
	readonly sessionFile: string;
	/** Parent session JSONL recorded by the child's `subagent_meta`, when persisted. */
	readonly parentSession?: string;
}

export type ResolvedSubagentSession = ResolvedLegacySubagentSession | ResolvedScopedSubagentSession;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDesktopSubagentOpenSessionRequest(value: unknown): DesktopSubagentOpenSessionRequest {
	if (!isRecord(value)
		|| typeof value.sessionId !== "string" || value.sessionId.length === 0
		|| typeof value.runDir !== "string" || value.runDir.trim().length === 0
		|| typeof value.agentId !== "string" || !SAFE_AGENT_ID.test(value.agentId)) {
		throw new RequestError(ERROR_INVALID_PARAMS, "pix/subagents/open_session requires sessionId, runDir and a safe agentId");
	}
	return { sessionId: value.sessionId, runDir: value.runDir, agentId: value.agentId };
}

export function isSubagentSessionLink(value: unknown): value is SubagentSessionLink {
	return isRecord(value)
		&& typeof value.runDir === "string" && value.runDir.length > 0
		&& typeof value.agentId === "string" && SAFE_AGENT_ID.test(value.agentId)
		&& (value.parentSessionId === undefined || typeof value.parentSessionId === "string");
}

function isStrictlyInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Parent session ids are UUIDs; legacy run directories are timestamp-named. */
const PARENT_SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `sessionFile` (canonical) sits directly in a parent-scoped
 * `.pi/subagents/<parentSessionId>/` directory of this project (decision 0072).
 */
function isParentScopedSessionFile(root: string, sessionFile: string): boolean {
	const dir = dirname(sessionFile);
	return dirname(dir) === root && PARENT_SESSION_DIR.test(basename(dir)) && sessionFile.endsWith(".jsonl");
}

export type ParentSubagentRemoval = "removed" | "absent" | "skipped-owned" | "skipped-unsafe";

/**
 * Remove `<cwd>/.pi/subagents/<parentSessionId>/` together with its deleted
 * parent session (decision 0072). Refuses non-UUID ids, symlinked roots or
 * directories, and directories that still hold owned-launch records, which
 * must stay until retirement proves both launchd services absent.
 */
export async function removeParentSubagentSessions(cwd: string, parentSessionId: string): Promise<ParentSubagentRemoval> {
	if (!PARENT_SESSION_DIR.test(parentSessionId)) return "skipped-unsafe";
	const expectedRoot = join(cwd, ".pi", "subagents");
	const root = await realpath(expectedRoot).catch(() => undefined);
	if (root === undefined) return "absent";
	if (root !== (await realpath(cwd).catch(() => cwd)) + `${sep}.pi${sep}subagents`) return "skipped-unsafe";
	const dir = join(root, parentSessionId);
	const info = await lstat(dir).catch(() => undefined);
	if (!info) return "absent";
	if (info.isSymbolicLink() || !info.isDirectory()) return "skipped-unsafe";
	if (await lstat(join(dir, "owned")).catch(() => undefined)) return "skipped-owned";
	await rm(dir, { recursive: true, force: true });
	return "removed";
}

/** Canonical legacy `<agent>/sessions/` root, when present and not a symlink. */
async function legacySessionRoot(agentDir: string, fail: (reason: string) => never): Promise<string | undefined> {
	const legacy = join(agentDir, "sessions");
	const legacyReal = await realpath(legacy).catch(() => undefined);
	if (legacyReal !== undefined && legacyReal !== legacy) fail("sessions directory must not be a symlink");
	return legacyReal;
}

/**
 * Resolve a sub-agent session file for `cwd`. Every hop is canonicalized so a
 * symlinked run, agent or session link cannot escape the allowed session roots.
 */
export async function resolveSubagentSession(cwd: string, runDir: string, agentId: string): Promise<ResolvedSubagentSession> {
	if (!SAFE_AGENT_ID.test(agentId)) throw new RequestError(ERROR_INVALID_PARAMS, "unsafe sub-agent id");
	const fail = (reason: string): never => {
		throw new RequestError(ERROR_SERVER, `sub-agent session unavailable: ${reason}`);
	};
	const rawRoot = join(cwd, ".pi", "subagents");
	const root = await realpath(rawRoot).catch(() => fail("project has no sub-agent runs"));
	const scoped = scopedRunParts(root, rawRoot, runDir);
	if (scoped) return await resolveScopedSession(root, scoped.scope, scoped.batch, agentId, fail);
	const requestedRun = isAbsolute(runDir) ? runDir : join(root, runDir);
	const run = await realpath(requestedRun).catch(() => fail("run directory not found"));
	if (!isStrictlyInside(root, run) || relative(root, run).includes(sep)) fail("run directory is outside the project sub-agent root");
	const agentDir = await realpath(join(run, agentId)).catch(() => fail("agent directory not found"));
	if (agentDir !== join(run, agentId)) fail("agent directory must not be a symlink");
	const legacy = await legacySessionRoot(agentDir, fail);
	const linked = (await readFile(join(agentDir, "session_file"), "utf8").catch(() => "")).trim();
	if (!linked) fail(legacy ? "agent has no recorded session file" : "agent has no persisted session");
	const sessionFile = await realpath(resolve(agentDir, linked)).catch(() => fail("session file not found"));
	const allowed = (legacy !== undefined && isStrictlyInside(legacy, sessionFile)) || isParentScopedSessionFile(root, sessionFile);
	if (!allowed) fail("session file is outside the agent sessions directory");
	if (!(await stat(sessionFile)).isFile()) fail("session file is not a regular file");
	return { kind: "legacy", runDir: run, agentId, agentDir, sessionFile };
}

/** `<scope>/<batch>` of a run key (absolute under the project root, or relative). */
function scopedRunParts(root: string, rawRoot: string, runDir: string): { scope: string; batch: string } | undefined {
	let rel = runDir;
	if (isAbsolute(runDir)) {
		const target = resolve(runDir);
		rel = [root, rawRoot].map((base) => relative(base, target)).find((candidate) => candidate.length > 0 && !candidate.startsWith("..") && !isAbsolute(candidate)) ?? "";
	}
	const parts = rel.split(/[\\/]+/).filter((part) => part.length > 0);
	if (parts.length !== 2) return undefined;
	const [scope, batch] = parts as [string, string];
	if (!PARENT_SESSION_DIR.test(scope) || !SAFE_BATCH.test(batch) || batch.includes("..")) return undefined;
	return { scope, batch };
}

async function resolveScopedSession(root: string, scope: string, batch: string, agentId: string, fail: (reason: string) => never): Promise<ResolvedScopedSubagentSession> {
	const scopeDir = join(root, scope);
	const scopeReal = await realpath(scopeDir).catch(() => fail("parent session scope not found"));
	if (scopeReal !== scopeDir) fail("parent session scope must not be a symlink");
	const match = await findChildSession(scopeDir, scope, batch, agentId);
	if (!match) fail("agent has no persisted session");
	return {
		kind: "scoped",
		runDir: join(root, scope, batch),
		agentId,
		scope,
		batch,
		scopeDir,
		sessionFile: match!.file,
		...(match!.parentSession ? { parentSession: match!.parentSession } : {}),
	};
}

interface ChildMeta {
	readonly batch?: unknown;
	readonly agentId?: unknown;
	readonly scope?: unknown;
	readonly parentSession?: unknown;
}

const metaCache = new Map<string, ChildMeta | null>();

/**
 * Newest regular `.jsonl` directly in the scope dir whose `subagent_meta`
 * names `batch`/`agentId` (agent-id reuse in a batch: latest wins). Symlinks
 * are never followed: `Dirent.isFile()` is false for them.
 */
async function findChildSession(scopeDir: string, scope: string, batch: string, agentId: string): Promise<{ file: string; parentSession?: string } | undefined> {
	const entries = await readdir(scopeDir, { withFileTypes: true }).catch(() => []);
	let best: { file: string; mtimeMs: number; meta: ChildMeta } | undefined;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const file = join(scopeDir, entry.name);
		const info = await lstat(file).catch(() => undefined);
		if (!info?.isFile()) continue;
		const meta = await readChildMeta(file, info);
		if (!meta || meta.batch !== batch || meta.agentId !== agentId) continue;
		if (meta.scope !== undefined && meta.scope !== scope) continue;
		if (!best || info.mtimeMs > best.mtimeMs) best = { file, mtimeMs: info.mtimeMs, meta };
	}
	if (!best) return undefined;
	const parent = best.meta.parentSession;
	const parentSession = typeof parent === "string" && isAbsolute(parent) && parent.endsWith(".jsonl") ? parent : undefined;
	return { file: best.file, ...(parentSession ? { parentSession } : {}) };
}

async function readChildMeta(file: string, info: { ino: number; size: number; mtimeMs: number }): Promise<ChildMeta | undefined> {
	const key = `${file}\0${info.ino}\0${info.size}\0${info.mtimeMs}`;
	const cached = metaCache.get(key);
	if (cached !== undefined) return cached ?? undefined;
	let meta: ChildMeta | null = null;
	const handle = await open(file, "r").catch(() => undefined);
	if (handle) {
		try {
			const buffer = Buffer.alloc(HEADER_READ_LIMIT);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const complete = buffer.subarray(0, bytesRead);
			const end = complete.lastIndexOf(0x0a);
			for (const line of complete.subarray(0, end < 0 ? 0 : end).toString("utf8").split("\n")) {
				const entry = parseJsonRecord(line);
				if (entry?.type === "custom" && entry.customType === SUBAGENT_META_ENTRY && isRecord(entry.data) && entry.data.version === 1) {
					meta = entry.data as ChildMeta;
					break;
				}
			}
		} finally {
			await handle.close();
		}
	}
	metaCache.set(key, meta);
	if (metaCache.size > META_CACHE_LIMIT) metaCache.delete(metaCache.keys().next().value!);
	return meta ?? undefined;
}

function parseJsonRecord(line: string): Record<string, unknown> | undefined {
	if (!line.trim()) return undefined;
	try {
		const value = JSON.parse(line) as unknown;
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

interface ParentFold {
	ino: number;
	offset: number;
	partial: Buffer;
	records: Map<string, Record<string, unknown>>;
}

const parentFolds = new Map<string, ParentFold>();
const parentReads = new Map<string, Promise<void>>();

/**
 * Fold the parent's lifecycle records incrementally: only bytes appended since
 * the previous read are parsed; a replaced or truncated file is re-read.
 * Reads of one parent are serialized so concurrent polls never interleave.
 */
async function readParentRecord(parentSession: string, scope: string, batch: string, agentId: string): Promise<Record<string, unknown> | undefined> {
	const prior = parentReads.get(parentSession) ?? Promise.resolve();
	const current = prior.then(() => refreshParentFold(parentSession));
	const settled = current.catch(() => undefined);
	parentReads.set(parentSession, settled);
	void settled.then(() => { if (parentReads.get(parentSession) === settled) parentReads.delete(parentSession); });
	await current.catch(() => undefined);
	return parentFolds.get(parentSession)?.records.get(`${scope}\0${batch}\0${agentId}`);
}

async function refreshParentFold(file: string): Promise<void> {
	const info = await stat(file).catch(() => undefined);
	if (!info?.isFile()) {
		parentFolds.delete(file);
		return;
	}
	let fold = parentFolds.get(file);
	if (!fold || fold.ino !== info.ino || info.size < fold.offset) {
		fold = { ino: info.ino, offset: 0, partial: Buffer.alloc(0), records: new Map() };
	}
	parentFolds.delete(file);
	parentFolds.set(file, fold);
	if (parentFolds.size > PARENT_CACHE_LIMIT) parentFolds.delete(parentFolds.keys().next().value!);
	if (info.size === fold.offset) return;
	const handle = await open(file, "r");
	try {
		while (fold.offset < info.size) {
			const chunk = Buffer.alloc(Math.min(PARENT_READ_CHUNK, info.size - fold.offset));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, fold.offset);
			if (bytesRead === 0) break;
			fold.offset += bytesRead;
			const data = Buffer.concat([fold.partial, chunk.subarray(0, bytesRead)]);
			const end = data.lastIndexOf(0x0a);
			fold.partial = end < 0 ? data : data.subarray(end + 1);
			if (end >= 0) foldParentLines(fold.records, data.subarray(0, end).toString("utf8"));
		}
	} finally {
		await handle.close();
	}
}

function foldParentLines(records: Map<string, Record<string, unknown>>, text: string): void {
	for (const line of text.split("\n")) {
		if (!line.includes(SUBAGENT_RECORD_ENTRY)) continue;
		const entry = parseJsonRecord(line);
		if (entry?.type !== "custom" || entry.customType !== SUBAGENT_RECORD_ENTRY || !isRecord(entry.data)) continue;
		const data = entry.data;
		if (data.version !== 1 || typeof data.scope !== "string" || typeof data.batch !== "string" || typeof data.agentId !== "string") continue;
		const key = `${data.scope}\0${data.batch}\0${data.agentId}`;
		const record = records.get(key) ?? {};
		for (const [field, value] of Object.entries(data)) {
			if (field === "version") continue;
			if (value === null) delete record[field];
			else record[field] = value;
		}
		records.set(key, record);
	}
}

/** Display-only status read: never used as an ownership or liveness proof. */
export async function readSubagentSessionState(resolved: ResolvedSubagentSession): Promise<SubagentSessionState> {
	if (resolved.kind === "scoped") {
		const [fileStat, record] = await Promise.all([
			stat(resolved.sessionFile).catch(() => undefined),
			resolved.parentSession
				? readParentRecord(resolved.parentSession, resolved.scope, resolved.batch, resolved.agentId)
				: Promise.resolve(undefined),
		]);
		const status = typeof record?.status === "string" ? record.status : "unknown";
		return {
			terminal: TERMINAL_STATUSES.has(status),
			revision: fileStat ? `${fileStat.size}:${fileStat.mtimeMs}:${status}` : "missing",
		};
	}
	const has = async (name: string) => (await lstat(join(resolved.agentDir, name)).catch(() => undefined)) !== undefined;
	const [exitCode, retryPending, nextRetry, fileStat] = await Promise.all([
		readFile(join(resolved.agentDir, "exit_code"), "utf8").then((text) => text.trim()).catch(() => ""),
		has("retry_pending"),
		has("next_retry_at"),
		stat(resolved.sessionFile).catch(() => undefined),
	]);
	return {
		terminal: exitCode.length > 0 && !retryPending && !nextRetry,
		revision: fileStat ? `${fileStat.size}:${fileStat.mtimeMs}` : "missing",
	};
}

/**
 * True for a child session path: inside a legacy project
 * `.pi/subagents/<run>/<agent>/sessions/` tree, or a `.jsonl` directly in a
 * parent-scoped `.pi/subagents/<parentSessionId>/` directory (decision 0072).
 */
export function isSubagentSessionPath(path: string): boolean {
	const parts = resolve(path).split(sep);
	const n = parts.length;
	if (path.endsWith(".jsonl") && n >= 4 && parts[n - 4] === ".pi" && parts[n - 3] === "subagents" && PARENT_SESSION_DIR.test(parts[n - 2] ?? "")) return true;
	for (let index = 0; index + 4 < parts.length; index++) {
		if (parts[index] === ".pi" && parts[index + 1] === "subagents" && parts[index + 4] === "sessions") return true;
	}
	return false;
}

/** Copy complete JSONL lines only; a partial trailing write is dropped. */
export async function snapshotSessionFile(source: string, target: string): Promise<void> {
	const content = await readFile(source);
	const end = content.lastIndexOf(0x0a);
	if (end < 0) throw new RequestError(ERROR_SERVER, "sub-agent session has no complete entries yet");
	await writeFile(target, content.subarray(0, end + 1), { flag: "wx" });
}

export async function readSessionHeaderId(sessionFile: string): Promise<string | undefined> {
	const content = await readFile(sessionFile).catch(() => undefined);
	if (!content) return undefined;
	const end = content.subarray(0, HEADER_READ_LIMIT).indexOf(0x0a);
	if (end < 0) return undefined;
	try {
		const header = JSON.parse(content.subarray(0, end).toString("utf8")) as unknown;
		return isRecord(header) && header.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Fork a sub-agent session into an ordinary session in Pi's default session
 * directory for `cwd`. The source file is never opened by SessionManager; the
 * new header's parentSession points at the original source, not the snapshot.
 */
export async function forkSubagentSession(sourceFile: string, cwd: string): Promise<{ sessionFile: string; piSessionId: string }> {
	const scratch = await mkdtemp(join(tmpdir(), "pix-subagent-fork-"));
	try {
		const snapshot = join(scratch, "source.jsonl");
		await snapshotSessionFile(sourceFile, snapshot);
		const manager = SessionManager.forkFrom(snapshot, cwd, undefined, { id: randomUUID() });
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new RequestError(ERROR_SERVER, "fork did not produce a session file");
		await rewriteParentSession(sessionFile, sourceFile);
		return { sessionFile, piSessionId: manager.getSessionId() };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function rewriteParentSession(sessionFile: string, parentSession: string): Promise<void> {
	const content = await readFile(sessionFile, "utf8");
	const end = content.indexOf("\n");
	if (end < 0) return;
	const header = JSON.parse(content.slice(0, end)) as Record<string, unknown>;
	header.parentSession = parentSession;
	await writeFile(sessionFile, `${JSON.stringify(header)}\n${content.slice(end + 1)}`);
}
