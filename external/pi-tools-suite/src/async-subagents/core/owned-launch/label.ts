// Per-run identity and secure-path primitives for owned-launch. Every
// launchd label and run directory is unique per run, so cleanup can only
// ever address jobs and files this launcher created (see README.md).
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OWNED_LAUNCH_LABEL_PREFIX = "org.pix.owned-launch.";
/** Directory under an agent dir holding the per-run UUID run directories. */
export const OWNED_LAUNCH_RUNS_DIRNAME = "owned-launch";

/** Fresh per-run launchd label (UUID suffix, validated by {@link isValidOwnedLaunchLabel}). */
export function ownedLaunchLabel(): string {
	return `${OWNED_LAUNCH_LABEL_PREFIX}${randomUUID()}`;
}

const LABEL_RE = /^org\.pix\.owned-launch\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Strict label validation: launchctl actions may only ever address labels matching this shape. */
export function isValidOwnedLaunchLabel(label: string): boolean {
	return LABEL_RE.test(label);
}

/**
 * Create a fresh 0700 directory owned by the current user. Refuses to reuse
 * an existing path (no symlink/traversal reuse) and verifies the mode after
 * creation. Returns the created path.
 */
export function createSecureDir(parent: string, name: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Unsafe owned-launch directory name: ${name}`);
	const dir = join(parent, name);
	let st: { isDirectory(): boolean; mode: number; uid: number };
	try {
		st = statSync(dir, { throwIfNoEntry: false }) as typeof st;
	} catch {
		st = undefined as unknown as typeof st;
	}
	if (st) throw new Error(`owned-launch run directory already exists: ${dir}`);
	mkdirSync(dir, { recursive: false, mode: 0o700 });
	const created = statSync(dir);
	if (!created.isDirectory() || (created.mode & 0o777) !== 0o700) {
		throw new Error(`owned-launch run directory is not a private directory: ${dir}`);
	}
	return dir;
}

/**
 * Ensure a directory exists with 0700 permissions (created or already correct). */
export function ensureSecureDir(dir: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = statSync(dir);
	if (!st.isDirectory() || (st.mode & 0o777) !== 0o700) {
		throw new Error(`owned-launch directory is not private: ${dir}`);
	}
	return dir;
}

const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * All owned-launch UUID run directories under an agent dir (empty when none
 * exist). Only exact UUID directory names match: hidden staging directories
 * (and anything else) are invisible to every run-directory reader, which is
 * what makes pre-launch staging safe. Sorted for deterministic order.
 */
export function listOwnedLaunchRunDirs(agentDir: string): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(agentDir, OWNED_LAUNCH_RUNS_DIRNAME), { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && UUID_DIR_RE.test(entry.name))
		.map((entry) => join(agentDir, OWNED_LAUNCH_RUNS_DIRNAME, entry.name))
		.sort();
}

/**
 * Per-generation order record, published atomically with the spec. Retries
 * reuse an agent directory and keep older retired UUID directories, and a
 * crash before the ownership pointer is written leaves the newest
 * generation unpointed; this strictly increasing number (never a clock)
 * identifies the newest generation without the pointer.
 */
export const OWNED_LAUNCH_GENERATION_FILE = "generation";

/** Parsed generation (>= 1) of a run directory, or undefined for legacy/malformed records. */
export function readOwnedLaunchGeneration(runDir: string): number | undefined {
	try {
		const match = /^generation=([1-9]\d{0,8})\n$/.exec(readFileSync(join(runDir, OWNED_LAUNCH_GENERATION_FILE), "utf8"));
		return match ? Number(match[1]) : undefined;
	} catch {
		return undefined;
	}
}

/** Next generation for a base dir: one above every surviving UUID run directory's record. */
export function nextOwnedLaunchGeneration(baseDir: string): number {
	let max = 0;
	let entries: Dirent[];
	try {
		entries = readdirSync(baseDir, { withFileTypes: true });
	} catch {
		return 1;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !UUID_DIR_RE.test(entry.name)) continue;
		max = Math.max(max, readOwnedLaunchGeneration(join(baseDir, entry.name)) ?? 0);
	}
	return max + 1;
}

// macOS sockaddr_un.sun_path is 104 bytes; the longest socket name we bind
// is "control.sock" (12) plus the separator.
const MAX_SOCKETS_DIR_LEN = 90;
const LONGEST_SOCKET_NAME = "control.sock".length + 1;

export interface SocketsDirChoice {
	dir: string;
	temporary: boolean;
}

/**
 * UNIX socket paths must fit sockaddr_un.sun_path (104 bytes). Long run
 * directories (deep project paths) fall back to a fresh 0700 mkdtemp under
 * the system temp root; short ones keep sockets next to the journal.
 */
export function resolveSocketsDir(runDir: string): SocketsDirChoice {
	if (runDir.length + LONGEST_SOCKET_NAME < 104 && runDir.length <= MAX_SOCKETS_DIR_LEN) {
		return { dir: runDir, temporary: false };
	}
	const dir = mkdtempSync(join(tmpdir(), "pi-owned-launch-"));
	const st = statSync(dir);
	if ((st.mode & 0o777) !== 0o700) throw new Error(`Insecure temp sockets dir: ${dir}`);
	return { dir, temporary: true };
}
