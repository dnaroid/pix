import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { dirname, join } from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { hashSerializedState, serializeState, type DcpState, type SerializedDcpState } from "./state.js"

const DCP_STATE_DIR = "dcp-state"
const DCP_STATE_EXT = ".json"
const DCP_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_SESSION_HEADER_BYTES = 64 * 1024

let lastPersistedStateHash: string | undefined
let saveQueue: Promise<void> = Promise.resolve()

function safeSessionFileName(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_") + DCP_STATE_EXT
}

export async function readSessionIdFromFile(sessionPath: string): Promise<string | undefined> {
	const file = await open(sessionPath, "r")
	try {
		const buffer = Buffer.alloc(MAX_SESSION_HEADER_BYTES)
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
		if (bytesRead <= 0) return undefined

		const content = buffer.subarray(0, bytesRead)
		const newlineIndex = content.indexOf(0x0a)
		if (newlineIndex < 0 && bytesRead === buffer.length) return undefined

		const firstLine = content.subarray(0, newlineIndex >= 0 ? newlineIndex : bytesRead).toString("utf8").trim()
		if (!firstLine) return undefined
		const parsed = JSON.parse(firstLine) as { type?: string; id?: unknown }
		return parsed.type === "session" && typeof parsed.id === "string" && parsed.id.length > 0
			? parsed.id
			: undefined
	} finally {
		await file.close()
	}
}

async function listSessionIds(sessionDir: string): Promise<string[]> {
	let entries: Dirent[]
	try {
		entries = await readdir(sessionDir, { withFileTypes: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}

	const sessionIds = new Set<string>()
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue

		const sessionPath = join(sessionDir, entry.name)
		try {
			const sessionId = await readSessionIdFromFile(sessionPath)
			if (sessionId) sessionIds.add(sessionId)
		} catch {
			// Ignore malformed or transient session files during cleanup.
		}
	}

	return [...sessionIds]
}

function resolveDcpStateDir(ctx: ExtensionContext): string | undefined {
	const sessionDir = ctx.sessionManager?.getSessionDir?.()
	if (!sessionDir) return undefined
	return join(sessionDir, DCP_STATE_DIR)
}

export function resolveDcpStatePath(ctx: ExtensionContext): string | undefined {
	const sessionId = ctx.sessionManager?.getSessionId?.()
	const stateDir = resolveDcpStateDir(ctx)
	if (!sessionId || !stateDir) return undefined
	return join(stateDir, safeSessionFileName(sessionId))
}

export function resetDcpPersistenceDedup(): void {
	lastPersistedStateHash = undefined
}

export async function loadDcpState(ctx: ExtensionContext): Promise<SerializedDcpState | undefined> {
	const statePath = resolveDcpStatePath(ctx)
	if (!statePath) return undefined

	try {
		const text = await readFile(statePath, "utf8")
		const data = JSON.parse(text) as SerializedDcpState
		lastPersistedStateHash = hashSerializedState(data)
		return data
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
}

/**
 * Load the DCP sidecar for an arbitrary session file path, e.g. the previous
 * session during fork/resume/new. Resolves the sidecar via the session file's
 * first-line session id rather than the live session manager, so it works
 * independent of the current ctx.sessionManager state.
 */
export async function loadDcpStateFromSessionFile(
	sessionFile: string,
): Promise<SerializedDcpState | undefined> {
	if (!sessionFile) return undefined

	try {
		const sessionId = await readSessionIdFromFile(sessionFile)
		if (!sessionId) return undefined
		const stateDir = join(dirname(sessionFile), DCP_STATE_DIR)
		const statePath = join(stateDir, safeSessionFileName(sessionId))
		const text = await readFile(statePath, "utf8")
		return JSON.parse(text) as SerializedDcpState
	} catch {
		// A missing/unreadable sidecar for the previous session (e.g. a fresh
		// fork with no prior compression) means there is simply nothing to inherit.
		return undefined
	}
}

export async function cleanupStaleDcpStateFiles(ctx: ExtensionContext): Promise<number> {
	const stateDir = resolveDcpStateDir(ctx)
	const sessionDir = ctx.sessionManager.getSessionDir()
	if (!stateDir || !sessionDir) return 0

	const currentSessionId = ctx.sessionManager.getSessionId()
	const liveStateFiles = new Set<string>()
	if (currentSessionId) liveStateFiles.add(safeSessionFileName(currentSessionId))

	const sessionIds = await listSessionIds(sessionDir)
	for (const sessionId of sessionIds) {
		liveStateFiles.add(safeSessionFileName(sessionId))
	}

	let entries: Dirent[]
	try {
		entries = await readdir(stateDir, { withFileTypes: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
		throw error
	}

	const now = Date.now()
	let deleted = 0
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(DCP_STATE_EXT)) continue
		if (currentSessionId && entry.name === safeSessionFileName(currentSessionId)) continue

		const statePath = join(stateDir, entry.name)
		const isLiveSession = liveStateFiles.has(entry.name)
		let isTooOld = false
		try {
			const info = await stat(statePath)
			isTooOld = now - info.mtimeMs > DCP_STATE_MAX_AGE_MS
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
			throw error
		}

		if (isLiveSession && !isTooOld) continue

		await unlink(statePath)
		deleted++
	}

	return deleted
}

export async function saveDcpState(ctx: ExtensionContext, state: DcpState): Promise<void> {
	const statePath = resolveDcpStatePath(ctx)
	if (!statePath) return

	const serialized = serializeState(state)
	const hash = hashSerializedState(serialized)
	if (hash === lastPersistedStateHash) return
	lastPersistedStateHash = hash

	saveQueue = saveQueue
		.catch(() => {
			// Keep later saves moving even if an earlier write failed.
		})
		.then(async () => {
			await mkdir(dirname(statePath), { recursive: true })
			await writeFile(statePath, JSON.stringify(serialized), "utf8")
		})

	try {
		await saveQueue
	} catch (error) {
		if (lastPersistedStateHash === hash) lastPersistedStateHash = undefined
		throw error
	}
}
