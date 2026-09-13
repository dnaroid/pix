import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ContextGatewayResolvedConfig } from "./types.js";

const TRUE_ENV_RE = /^(1|true|yes|on)$/i;
const FALSE_ENV_RE = /^(0|false|no|off)$/i;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 3;
const MIN_MAX_BACKUPS = 1;
const MAX_MAX_BYTES = 64 * 1024 * 1024;
const MAX_MAX_BACKUPS = 100;
const ROTATION_CHECK_INTERVAL = 32;
const MAX_TRACKED_LOG_PATHS = 64;
const MAX_REPORTED_FAILURES = 32;
const ROTATION_LOCK_STALE_MS = 30_000;

interface RotationLockOwner {
	pid: number;
	token: string;
}

function truthyEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (TRUE_ENV_RE.test(trimmed)) return true;
	if (FALSE_ENV_RE.test(trimmed)) return false;
	return undefined;
}

function positiveIntEnv(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!/^\d+$/.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function contextGatewayAccountingLogEnabled(config: ContextGatewayResolvedConfig): boolean {
	return truthyEnv(process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_LOG_ENABLED)
		?? config.accountingLog?.enabled
		?? true;
}

export function contextGatewayAccountingLogPath(): string {
	const explicit = process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_LOG?.trim();
	if (explicit) return explicit;
	const agentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "context-gateway-accounting.jsonl");
}

export function contextGatewayAccountingLogMaxBytes(config: ContextGatewayResolvedConfig): number {
	const envValue = positiveIntEnv(process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BYTES);
	return (envValue !== undefined && envValue <= MAX_MAX_BYTES ? envValue : undefined)
		?? config.accountingLog?.maxBytes
		?? DEFAULT_MAX_BYTES;
}

export function contextGatewayAccountingLogMaxBackups(config: ContextGatewayResolvedConfig): number {
	const envValue = positiveIntEnv(process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BACKUPS);
	const value = (envValue !== undefined && envValue <= MAX_MAX_BACKUPS ? envValue : undefined)
		?? config.accountingLog?.maxBackups
		?? DEFAULT_MAX_BACKUPS;
	return Math.max(MIN_MAX_BACKUPS, Math.floor(value));
}

let writeChain: Promise<void> = Promise.resolve();
const ensuredDirs = new Set<string>();
const appendsSinceRotationCheck = new Map<string, number>();
const reportedFailures = new Set<string>();

function errorCode(error: unknown): string {
	if (!error || typeof error !== "object" || !("code" in error)) return "unknown";
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : "unknown";
}

function reportFailure(operation: string, error: unknown): void {
	const key = `${operation}:${errorCode(error)}`;
	if (reportedFailures.has(key)) return;
	if (reportedFailures.size >= MAX_REPORTED_FAILURES) reportedFailures.clear();
	reportedFailures.add(key);
	process.emitWarning(
		`Context Gateway accounting ${operation} failed (${errorCode(error)}); accounting remains best-effort.`,
		{ code: "PI_CONTEXT_GATEWAY_ACCOUNTING_FAILURE" },
	);
}

function setAppendCount(logPath: string, count: number): void {
	if (!appendsSinceRotationCheck.has(logPath) && appendsSinceRotationCheck.size >= MAX_TRACKED_LOG_PATHS) {
		const oldest = appendsSinceRotationCheck.keys().next().value;
		if (oldest !== undefined) appendsSinceRotationCheck.delete(oldest);
	}
	appendsSinceRotationCheck.set(logPath, count);
}

async function ensureLogDir(logPath: string): Promise<void> {
	const dir = path.dirname(logPath);
	if (ensuredDirs.delete(dir)) {
		ensuredDirs.add(dir);
		return;
	}
	await fs.mkdir(dir, { recursive: true });
	if (ensuredDirs.size >= MAX_TRACKED_LOG_PATHS) {
		const oldest = ensuredDirs.values().next().value;
		if (oldest !== undefined) ensuredDirs.delete(oldest);
	}
	ensuredDirs.add(dir);
}

function rotationLockOwner(): RotationLockOwner {
	return {
		pid: process.pid,
		token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	};
}

function isRotationLockOwner(value: unknown): value is RotationLockOwner {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RotationLockOwner>;
	return Number.isInteger(candidate.pid) && (candidate.pid ?? 0) > 0 && typeof candidate.token === "string";
}

async function readRotationLockOwner(lockPath: string): Promise<RotationLockOwner | undefined> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(lockPath, "utf8"));
		return isRotationLockOwner(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

async function createRotationLock(lockPath: string, owner: RotationLockOwner): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof fs.open>>;
	try {
		handle = await fs.open(lockPath, "wx", 0o600);
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	}
	try {
		await handle.writeFile(JSON.stringify(owner), "utf8");
	} catch (error) {
		await handle.close();
		await fs.unlink(lockPath).catch(() => {});
		throw error;
	}
	await handle.close();
	return true;
}

async function acquireRotationLock(lockPath: string, owner: RotationLockOwner): Promise<boolean> {
	if (await createRotationLock(lockPath, owner)) return true;

	let lockStat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		lockStat = await fs.stat(lockPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return createRotationLock(lockPath, owner);
		throw error;
	}
	const existingOwner = await readRotationLockOwner(lockPath);
	if (existingOwner && isProcessAlive(existingOwner.pid)) return false;
	if (!existingOwner && Date.now() - lockStat.mtimeMs <= ROTATION_LOCK_STALE_MS) return false;

	const quarantinePath = `${lockPath}.stale-${owner.token}`;
	try {
		await fs.rename(lockPath, quarantinePath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return createRotationLock(lockPath, owner);
		throw error;
	}
	const movedStat = await fs.stat(quarantinePath);
	if (movedStat.dev !== lockStat.dev || movedStat.ino !== lockStat.ino) {
		await fs.rename(quarantinePath, lockPath).catch(() => {});
		return false;
	}
	await fs.rm(quarantinePath, { recursive: true, force: true });
	return createRotationLock(lockPath, owner);
}

async function releaseRotationLock(lockPath: string, owner: RotationLockOwner): Promise<void> {
	const currentOwner = await readRotationLockOwner(lockPath);
	if (currentOwner?.token !== owner.token) {
		reportFailure("rotation lock ownership", { code: "EBUSY" });
		return;
	}
	await fs.unlink(lockPath);
}

async function rotateIfNeeded(logPath: string, maxBytes: number, maxBackups: number): Promise<void> {
	const lockPath = `${logPath}.rotation.lock`;
	const lockOwner = rotationLockOwner();
	let locked = false;
	try {
		locked = await acquireRotationLock(lockPath, lockOwner);
		if (!locked) {
			reportFailure("rotation lock", { code: "EBUSY" });
			return;
		}

		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(logPath);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return;
			throw error;
		}
		if (stat.size < maxBytes) return;

		const dir = path.dirname(logPath);
		const base = path.basename(logPath);
		await fs.rm(path.join(dir, `${base}.${maxBackups}`), { force: true });
		for (let index = maxBackups - 1; index >= 1; index--) {
			try {
				await fs.rename(path.join(dir, `${base}.${index}`), path.join(dir, `${base}.${index + 1}`));
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error;
			}
		}
		await fs.rename(logPath, path.join(dir, `${base}.1`));
	} catch (error) {
		reportFailure("rotation", error);
	} finally {
		if (locked) {
			await releaseRotationLock(lockPath, lockOwner).catch((error) => reportFailure("rotation unlock", error));
		}
	}
}

async function appendRecord(
	logPath: string,
	record: Record<string, unknown>,
	maxBytes: number,
	maxBackups: number,
): Promise<void> {
	await ensureLogDir(logPath);
	const appendCount = appendsSinceRotationCheck.get(logPath) ?? ROTATION_CHECK_INTERVAL;
	if (appendCount >= ROTATION_CHECK_INTERVAL) {
		await rotateIfNeeded(logPath, maxBytes, maxBackups);
		setAppendCount(logPath, 0);
	}
	await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
	setAppendCount(logPath, (appendsSinceRotationCheck.get(logPath) ?? 0) + 1);
}

export function writeContextGatewayAccountingLog(
	config: ContextGatewayResolvedConfig,
	event: string,
	details: Record<string, unknown> = {},
): void {
	if (!contextGatewayAccountingLogEnabled(config)) return;
	const record = {
		version: 1,
		ts: new Date().toISOString(),
		event,
		...details,
	};
	const logPath = contextGatewayAccountingLogPath();
	const maxBytes = contextGatewayAccountingLogMaxBytes(config);
	const maxBackups = contextGatewayAccountingLogMaxBackups(config);
	writeChain = writeChain
		.then(() => appendRecord(logPath, record, maxBytes, maxBackups))
		.catch((error) => {
			// Accounting must never affect the session, provider call, or tool outcome.
			reportFailure("write", error);
		});
}

export function contextGatewayAccountingLogDrain(): Promise<void> {
	return writeChain;
}
