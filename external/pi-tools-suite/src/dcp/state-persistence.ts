import { createHash } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { hashSerializedState, serializeState, type DcpState, type SerializedDcpState } from "./state.js"

const DCP_STATE_DIR = "dcp-state"
const DCP_STATE_EXT = ".json"
const DCP_STATE_SCHEMA_VERSION = 1
const DCP_STATE_MAX_BYTES = 8 * 1024 * 1024
const MAX_SESSION_HEADER_BYTES = 64 * 1024
const MAX_COMPRESSION_BLOCKS = 10_000
const MAX_STATE_ARRAY_ITEMS = 100_000

const lastPersistedStateHashByPath = new Map<string, string>()
const lastPersistedGenerationByPath = new Map<string, number>()
const saveQueueByPath = new Map<string, Promise<void>>()
const recoveryBlockedPaths = new Set<string>()
let tempFileCounter = 0

export class DcpPersistenceConflictError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "DcpPersistenceConflictError"
	}
}


export interface DcpPersistenceTarget {
	statePath: string
	/** Exact unsanitized session identity captured before any async work. */
	sessionId?: string
}

export interface DcpStateEnvelope {
	kind: "dcp-state"
	schemaVersion: typeof DCP_STATE_SCHEMA_VERSION
	sessionId: string
	generation: number
	revision: string
	payloadHash: string
	payload: SerializedDcpState
}

interface DecodedStateDocument {
	payload: SerializedDcpState
	generation: number
	envelope: boolean
}

function safeSessionFileName(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_") + DCP_STATE_EXT
}

function previousStatePath(statePath: string): string {
	return `${statePath}.prev`
}

function fallbackSessionIdFromPath(statePath: string): string {
	const name = basename(statePath)
	return name.endsWith(DCP_STATE_EXT) ? name.slice(0, -DCP_STATE_EXT.length) : name
}

function payloadSha256(payload: SerializedDcpState): string {
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

function finiteNonNegative(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function boundedArray(value: unknown, limit = MAX_STATE_ARRAY_ITEMS): value is unknown[] {
	return Array.isArray(value) && value.length <= limit
}

function validateCompressionBlockGraph(blocks: unknown[]): void {
	if (blocks.length > MAX_COMPRESSION_BLOCKS) throw new Error("DCP state has too many compression blocks")
	const ids = new Set<number>()
	const edges = new Map<number, number[]>()

	for (const raw of blocks) {
		if (!raw || typeof raw !== "object") throw new Error("DCP state contains a non-object compression block")
		const block = raw as any
		if (!Number.isInteger(block.id) || block.id <= 0 || ids.has(block.id)) {
			throw new Error("DCP state contains an invalid or duplicate compression block id")
		}
		ids.add(block.id)
		if (typeof block.topic !== "string" || typeof block.summary !== "string") {
			throw new Error(`DCP compression block b${block.id} has invalid text fields`)
		}
		if (!Number.isFinite(block.startTimestamp) || !Number.isFinite(block.endTimestamp)) {
			throw new Error(`DCP compression block b${block.id} has invalid boundaries`)
		}
		if (block.startTimestamp > block.endTimestamp) {
			throw new Error(`DCP compression block b${block.id} has reversed boundaries`)
		}
		if (typeof block.active !== "boolean" || !finiteNonNegative(block.summaryTokenEstimate)) {
			throw new Error(`DCP compression block b${block.id} has invalid state fields`)
		}
		const covered = block.coveredBlockIds ?? []
		if (!boundedArray(covered, MAX_COMPRESSION_BLOCKS) || covered.some((id: unknown) => !Number.isInteger(id) || (id as number) <= 0)) {
			throw new Error(`DCP compression block b${block.id} has invalid coveredBlockIds`)
		}
		if (new Set(covered).size !== covered.length || covered.includes(block.id)) {
			throw new Error(`DCP compression block b${block.id} has a cyclic/self duplicate block reference`)
		}
		edges.set(block.id, [...covered] as number[])
	}

	for (const [id, covered] of edges) {
		for (const child of covered) {
			if (!ids.has(child)) throw new Error(`DCP compression block b${id} references missing block b${child}`)
		}
	}

	const visiting = new Set<number>()
	const visited = new Set<number>()
	const visit = (id: number): void => {
		if (visited.has(id)) return
		if (visiting.has(id)) throw new Error(`DCP compression block graph contains a cycle at b${id}`)
		visiting.add(id)
		for (const child of edges.get(id) ?? []) visit(child)
		visiting.delete(id)
		visited.add(id)
	}
	for (const id of ids) visit(id)
}

/**
 * Reject structurally unsafe/corrupt state before restore. New generation
 * envelopes are strict; legacy flat payloads may omit fields that restoreState
 * intentionally migrates with safe defaults.
 */
export function validateSerializedDcpState(
	value: unknown,
	options: { legacy?: boolean } = {},
): asserts value is SerializedDcpState {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DCP state payload must be an object")
	const state = value as any
	const legacy = options.legacy === true

	// Even the oldest supported sidecar must be recognizable as DCP state; do
	// not interpret an arbitrary JSON object as an empty session.
	if (legacy && !Object.prototype.hasOwnProperty.call(state, "compressionBlocks")) {
		throw new Error("Legacy DCP state has no compressionBlocks field")
	}
	if (!boundedArray(state.compressionBlocks, MAX_COMPRESSION_BLOCKS)) throw new Error("DCP state compressionBlocks is invalid")
	validateCompressionBlockGraph(state.compressionBlocks)

	const requireOrValidate = (
		name: string,
		predicate: (value: unknown) => boolean,
	): void => {
		const present = Object.prototype.hasOwnProperty.call(state, name)
		if (!present && legacy) return
		if (!present || !predicate(state[name])) throw new Error(`DCP state ${name} is invalid`)
	}

	requireOrValidate("nextBlockId", (value) => Number.isInteger(value) && (value as number) > 0)
	requireOrValidate("prunedToolIds", (value) => boundedArray(value) && value.every((id) => typeof id === "string"))
	requireOrValidate("prunedToolReasons", (value) => boundedArray(value) && value.every(
		(entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string",
	))
	requireOrValidate("tokensSaved", finiteNonNegative)
	requireOrValidate("totalPruneCount", finiteNonNegative)
	requireOrValidate("accountedCompressionBlockIds", (value) => boundedArray(value) && value.every(
		(id) => Number.isInteger(id) && (id as number) > 0,
	))
	requireOrValidate("compressionTokenSavings", (value) => boundedArray(value) && value.every(
		(entry) => Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) && finiteNonNegative(entry[1]),
	))
	requireOrValidate("accountedPrunedToolIds", (value) => boundedArray(value) && value.every((id) => typeof id === "string"))
	requireOrValidate("manualMode", (value) => typeof value === "boolean")

	if (state.compactToolCalls !== undefined && !boundedArray(state.compactToolCalls)) throw new Error("DCP state compactToolCalls is invalid")
	if (state.toolCalls !== undefined && !boundedArray(state.toolCalls)) throw new Error("DCP state legacy toolCalls is invalid")
	if (state.providerSeenToolIds !== undefined && (!boundedArray(state.providerSeenToolIds) || state.providerSeenToolIds.some((id: unknown) => typeof id !== "string"))) throw new Error("DCP state providerSeenToolIds is invalid")
	if (state.messageIdsByStableId !== undefined && (!boundedArray(state.messageIdsByStableId) || state.messageIdsByStableId.some((entry: unknown) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string"))) throw new Error("DCP state messageIdsByStableId is invalid")
}

function decodeStateDocument(text: string, expectedSessionId?: string): DecodedStateDocument {
	const raw = JSON.parse(text) as unknown
	if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as any).kind === "dcp-state") {
		const envelope = raw as Partial<DcpStateEnvelope>
		if (envelope.schemaVersion !== DCP_STATE_SCHEMA_VERSION) throw new Error(`Unsupported DCP state schema version: ${String(envelope.schemaVersion)}`)
		if (typeof envelope.sessionId !== "string" || envelope.sessionId.length === 0) throw new Error("DCP state envelope has no session identity")
		if (expectedSessionId && envelope.sessionId !== expectedSessionId) throw new Error(`DCP state session mismatch: expected ${expectedSessionId}, got ${envelope.sessionId}`)
		if (!Number.isInteger(envelope.generation) || (envelope.generation ?? 0) <= 0) throw new Error("DCP state generation is invalid")
		if (typeof envelope.payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(envelope.payloadHash)) throw new Error("DCP state payload hash is invalid")
		if (typeof envelope.revision !== "string" || envelope.revision !== envelope.payloadHash) throw new Error("DCP state revision is invalid")
		validateSerializedDcpState(envelope.payload)
		const actualHash = payloadSha256(envelope.payload)
		if (actualHash !== envelope.payloadHash) throw new Error("DCP state payload hash mismatch")
		return { payload: envelope.payload, generation: envelope.generation!, envelope: true }
	}

	// Legacy migration adapter: pre-E07 writers persisted SerializedDcpState
	// directly and older generations legitimately lack later accounting fields.
	validateSerializedDcpState(raw, { legacy: true })
	return { payload: raw, generation: 0, envelope: false }
}

async function readBoundedStateText(statePath: string): Promise<string> {
	const info = await stat(statePath)
	if (!info.isFile()) throw new Error(`DCP state path is not a regular file: ${statePath}`)
	if (info.size > DCP_STATE_MAX_BYTES) throw new Error(`DCP state file exceeds ${DCP_STATE_MAX_BYTES} bytes`)
	return readFile(statePath, "utf8")
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

async function listSessionIds(sessionDir: string): Promise<{ sessionIds: string[]; complete: boolean }> {
	let entries: Dirent[]
	try {
		entries = await readdir(sessionDir, { withFileTypes: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessionIds: [], complete: true }
		throw error
	}

	const sessionIds = new Set<string>()
	let complete = true
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue

		const sessionPath = join(sessionDir, entry.name)
		try {
			const sessionId = await readSessionIdFromFile(sessionPath)
			if (sessionId) sessionIds.add(sessionId)
			else complete = false
		} catch {
			// A transient/malformed session header makes ownership uncertain. Fail
			// closed: cleanup must not infer orphanhood from an incomplete scan.
			complete = false
		}
	}

	return { sessionIds: [...sessionIds], complete }
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

export function captureDcpPersistenceTarget(ctx: ExtensionContext): DcpPersistenceTarget | undefined {
	const sessionId = ctx.sessionManager?.getSessionId?.()
	const statePath = resolveDcpStatePath(ctx)
	return statePath ? { statePath, sessionId: sessionId || undefined } : undefined
}

export function resetDcpPersistenceDedup(): void {
	lastPersistedStateHashByPath.clear()
	lastPersistedGenerationByPath.clear()
	saveQueueByPath.clear()
	recoveryBlockedPaths.clear()
}

function isUnsupportedDirectorySync(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code
	return code === "EINVAL" || code === "ENOTSUP" || code === "EBADF" || code === "EPERM"
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		handle = await open(directory, "r")
		await handle.sync()
	} catch (error) {
		if (!isUnsupportedDirectorySync(error)) throw error
	} finally {
		await handle?.close().catch(() => {})
	}
}

async function atomicWriteStateFile(statePath: string, serializedText: string): Promise<void> {
	const directory = dirname(statePath)
	await mkdir(directory, { recursive: true })
	const tempPath = `${statePath}.tmp-${Date.now()}-${++tempFileCounter}`
	let handle: Awaited<ReturnType<typeof open>> | undefined

	try {
		handle = await open(tempPath, "w", 0o600)
		await handle.writeFile(serializedText, "utf8")
		await handle.sync()
		await handle.close()
		handle = undefined
		await rename(tempPath, statePath)
		await syncDirectory(directory)
	} catch (error) {
		await handle?.close().catch(() => {})
		await unlink(tempPath).catch(() => {})
		throw error
	}
}

async function quarantineCorruptState(statePath: string): Promise<string | undefined> {
	const quarantinePath = `${statePath}.corrupt-${Date.now()}-${++tempFileCounter}`
	try {
		await rename(statePath, quarantinePath)
		await syncDirectory(dirname(statePath))
		return quarantinePath
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
}

async function loadStatePath(statePath: string, expectedSessionId?: string): Promise<SerializedDcpState | undefined> {
	let primaryError: unknown
	try {
		const text = await readBoundedStateText(statePath)
		const decoded = decodeStateDocument(text, expectedSessionId)
		lastPersistedStateHashByPath.set(statePath, hashSerializedState(decoded.payload))
		lastPersistedGenerationByPath.set(statePath, decoded.generation)
		recoveryBlockedPaths.delete(statePath)
		return decoded.payload
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			primaryError = undefined
		} else {
			primaryError = error
			await quarantineCorruptState(statePath)
		}
	}

	try {
		const previousPath = previousStatePath(statePath)
		const text = await readBoundedStateText(previousPath)
		const decoded = decodeStateDocument(text, expectedSessionId)
		lastPersistedStateHashByPath.set(statePath, hashSerializedState(decoded.payload))
		lastPersistedGenerationByPath.set(statePath, decoded.generation)
		recoveryBlockedPaths.delete(statePath)
		return decoded.payload
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			await quarantineCorruptState(previousStatePath(statePath)).catch(() => {})
		}
	}

	if (primaryError) {
		// Keep startup usable from raw history, but make subsequent writes fail
		// closed until a valid generation is recovered/explicitly repaired.
		recoveryBlockedPaths.add(statePath)
	}
	return undefined
}

export async function loadDcpState(ctx: ExtensionContext): Promise<SerializedDcpState | undefined> {
	const statePath = resolveDcpStatePath(ctx)
	if (!statePath) return undefined
	const sessionId = ctx.sessionManager?.getSessionId?.() || undefined
	return loadStatePath(statePath, sessionId)
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
		return await loadStatePath(statePath, sessionId)
	} catch {
		// A missing/unreadable previous session means there is nothing safe to inherit.
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

	const scan = await listSessionIds(sessionDir)
	if (!scan.complete) return 0
	for (const sessionId of scan.sessionIds) liveStateFiles.add(safeSessionFileName(sessionId))

	let entries: Dirent[]
	try {
		entries = await readdir(stateDir, { withFileTypes: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
		throw error
	}

	let deleted = 0
	for (const entry of entries) {
		// .prev and .corrupt-* generations are recovery material, not ownership
		// roots. They are removed together with an orphaned primary sidecar.
		if (!entry.isFile() || !entry.name.endsWith(DCP_STATE_EXT)) continue
		if (liveStateFiles.has(entry.name)) continue

		const statePath = join(stateDir, entry.name)
		await unlink(statePath)
		await unlink(previousStatePath(statePath)).catch(() => {})
		deleted++
	}

	return deleted
}

async function withInterprocessStateLock<T>(statePath: string, action: () => Promise<T>): Promise<T> {
	const lockPath = `${statePath}.lock`
	await mkdir(dirname(statePath), { recursive: true })
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		try {
			handle = await open(lockPath, "wx", 0o600)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new DcpPersistenceConflictError(
					`Concurrent DCP writer owns ${lockPath}; refusing last-writer-wins publication`,
				)
			}
			throw error
		}
		await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8")
		await handle.sync()
		return await action()
	} finally {
		await handle?.close().catch(() => {})
		if (handle) {
			await unlink(lockPath).catch(() => {})
			await syncDirectory(dirname(statePath)).catch(() => {})
		}
	}
}

async function currentGenerationForSave(statePath: string, sessionId: string): Promise<number> {
	const cached = lastPersistedGenerationByPath.get(statePath)
	if (cached !== undefined) return cached
	if (recoveryBlockedPaths.has(statePath)) throw new Error(`DCP state recovery is blocked for ${statePath}; refusing to overwrite an unrecovered generation`)

	try {
		const text = await readBoundedStateText(statePath)
		const decoded = decodeStateDocument(text, sessionId)
		lastPersistedGenerationByPath.set(statePath, decoded.generation)
		lastPersistedStateHashByPath.set(statePath, hashSerializedState(decoded.payload))
		return decoded.generation
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			recoveryBlockedPaths.add(statePath)
			throw new Error(`Refusing to overwrite unreadable DCP state at ${statePath}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	try {
		const text = await readBoundedStateText(previousStatePath(statePath))
		const decoded = decodeStateDocument(text, sessionId)
		lastPersistedGenerationByPath.set(statePath, decoded.generation)
		return decoded.generation
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			recoveryBlockedPaths.add(statePath)
			throw new Error(`Refusing to overwrite unreadable previous DCP state at ${statePath}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
	return 0
}

async function backupCurrentGeneration(statePath: string, sessionId: string): Promise<void> {
	try {
		const text = await readBoundedStateText(statePath)
		decodeStateDocument(text, sessionId)
		await atomicWriteStateFile(previousStatePath(statePath), text)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return
		throw error
	}
}

export async function saveDcpStateToTarget(target: DcpPersistenceTarget, state: DcpState): Promise<void> {
	const statePath = target.statePath
	const sessionId = target.sessionId || fallbackSessionIdFromPath(statePath)
	const serialized = serializeState(state)
	validateSerializedDcpState(serialized)
	const hash = hashSerializedState(serialized)
	if (hash === lastPersistedStateHashByPath.get(statePath)) return
	const immutablePayload = JSON.parse(JSON.stringify(serialized)) as SerializedDcpState
	const payloadHash = payloadSha256(immutablePayload)

	const previous = saveQueueByPath.get(statePath) ?? Promise.resolve()
	const saveQueue = previous
		.catch(() => {
			// Keep later saves moving even if an earlier write failed.
		})
		.then(async () => withInterprocessStateLock(statePath, async () => {
			if (recoveryBlockedPaths.has(statePath)) {
				throw new Error(`DCP state recovery is blocked for ${statePath}; refusing to overwrite an unrecovered generation`)
			}
			// The in-memory generation cache is only authoritative inside this
			// process. Re-read the on-disk generation while holding the cross-process
			// lock so a writer that committed before us cannot be overwritten from a
			// stale cached revision.
			lastPersistedGenerationByPath.delete(statePath)
			const generation = (await currentGenerationForSave(statePath, sessionId)) + 1
			const envelope: DcpStateEnvelope = {
				kind: "dcp-state",
				schemaVersion: DCP_STATE_SCHEMA_VERSION,
				sessionId,
				generation,
				revision: payloadHash,
				payloadHash,
				payload: immutablePayload,
			}
			await backupCurrentGeneration(statePath, sessionId)
			await atomicWriteStateFile(statePath, JSON.stringify(envelope))
			lastPersistedStateHashByPath.set(statePath, hash)
			lastPersistedGenerationByPath.set(statePath, generation)
		}))
	saveQueueByPath.set(statePath, saveQueue)

	try {
		await saveQueue
	} finally {
		if (saveQueueByPath.get(statePath) === saveQueue) saveQueueByPath.delete(statePath)
	}
}

export async function saveDcpState(ctx: ExtensionContext, state: DcpState): Promise<void> {
	const target = captureDcpPersistenceTarget(ctx)
	if (!target) return
	await saveDcpStateToTarget(target, state)
}
