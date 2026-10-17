/**
 * Read-only Desktop viewers for async-subagent sessions.
 *
 * A sub-agent JSONL is owned by its parent (spawn/send). Desktop never opens it
 * through a Pi runtime because loading, migrations, session_start handlers and
 * metadata writes can append to the file. Viewers read persisted history only;
 * "continue in a new session" forks from a truncated snapshot copy.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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

export interface ResolvedSubagentSession {
	readonly runDir: string;
	readonly agentId: string;
	readonly agentDir: string;
	readonly sessionFile: string;
}

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
	const root = await realpath(join(cwd, ".pi", "subagents")).catch(() => fail("project has no sub-agent runs"));
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
	return { runDir: run, agentId, agentDir, sessionFile };
}

/** Display-only status read: never used as an ownership or liveness proof. */
export async function readSubagentSessionState(resolved: ResolvedSubagentSession): Promise<SubagentSessionState> {
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
