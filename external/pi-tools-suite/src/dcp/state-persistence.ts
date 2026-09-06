import { createHash } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { hashSerializedState, serializeState, type DcpState, type SerializedDcpState } from "./state.js"
import { dcpDiskRevisions, type DcpDiskRevision } from "./persistence-ownership.js"

const DCP_STATE_DIR = "dcp-state"
const DCP_STATE_EXT = ".json"
const DCP_STATE_RECOVERY_MARKER_SUFFIX = ".recovery-required"
const DCP_STATE_REVISION_FENCE_SUFFIX = ".fence"
const DCP_STATE_SCHEMA_VERSION = 1
const DCP_STATE_MAX_BYTES = 8 * 1024 * 1024
const MAX_SESSION_HEADER_BYTES = 64 * 1024
const MAX_COMPRESSION_BLOCKS = 10_000
const MAX_STATE_ARRAY_ITEMS = 100_000
const DCP_CLEANUP_MTIME_GRACE_MS = 2_000

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

/** Content/shape failures are recoverable from a valid previous generation. */
class DcpStateCorruptionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "DcpStateCorruptionError"
	}
}

interface StateDocumentRead {
	status: "valid" | "missing" | "corrupt"
	decoded?: DecodedStateDocument
	error?: DcpStateCorruptionError
}

interface RevisionFenceRead {
	status: "valid" | "missing" | "corrupt"
	revision?: DcpDiskRevision
	error?: DcpStateCorruptionError
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

function recoveryMarkerPath(statePath: string): string {
	return `${statePath}${DCP_STATE_RECOVERY_MARKER_SUFFIX}`
}

function revisionFencePath(statePath: string): string {
	return `${statePath}${DCP_STATE_REVISION_FENCE_SUFFIX}`
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
		if (block.startTimestamp > block.endTimestamp && !Array.isArray(block.mutationMembers)) {
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
	try {
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
	} catch (error) {
		if (error instanceof DcpStateCorruptionError) throw error
		throw new DcpStateCorruptionError(
			error instanceof Error ? error.message : `Invalid DCP state document: ${String(error)}`,
		)
	}
}

async function readBoundedStateText(statePath: string): Promise<string> {
	const info = await stat(statePath)
	if (!info.isFile()) throw new DcpStateCorruptionError(`DCP state path is not a regular file: ${statePath}`)
	if (info.size > DCP_STATE_MAX_BYTES) throw new DcpStateCorruptionError(`DCP state file exceeds ${DCP_STATE_MAX_BYTES} bytes`)
	return readFile(statePath, "utf8")
}

function errorCode(error: unknown): string | undefined {
	const code = (error as NodeJS.ErrnoException | undefined)?.code
	return typeof code === "string" ? code : undefined
}

function isMissingStateError(error: unknown): boolean {
	return errorCode(error) === "ENOENT"
}

/** Node filesystem errors are operational failures, not proof of corruption. */
function isFilesystemError(error: unknown): boolean {
	return errorCode(error) !== undefined
}

async function readStateDocument(
	statePath: string,
	expectedSessionId?: string,
): Promise<StateDocumentRead> {
	try {
		return {
			status: "valid",
			decoded: decodeStateDocument(await readBoundedStateText(statePath), expectedSessionId),
		}
	} catch (error) {
		if (isMissingStateError(error)) return { status: "missing" }
		if (error instanceof DcpStateCorruptionError || !isFilesystemError(error)) {
			const corruption = error instanceof DcpStateCorruptionError
				? error
				: new DcpStateCorruptionError(error instanceof Error ? error.message : String(error))
			return { status: "corrupt", error: corruption }
		}
		throw error
	}
}

function decodeRevisionFence(text: string, expectedSessionId?: string): DcpDiskRevision {
	try {
		const raw = JSON.parse(text) as {
			kind?: unknown
			schemaVersion?: unknown
			sessionId?: unknown
			generation?: unknown
			payloadHash?: unknown
		}
		if (!raw || typeof raw !== "object" || raw.kind !== "dcp-state-fence") {
			throw new Error("DCP revision fence has invalid kind")
		}
		if (raw.schemaVersion !== 1) throw new Error("DCP revision fence has invalid schema version")
		if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) throw new Error("DCP revision fence has no session identity")
		if (expectedSessionId && raw.sessionId !== expectedSessionId) {
			throw new Error(`DCP revision fence session mismatch: expected ${expectedSessionId}, got ${raw.sessionId}`)
		}
		if (!Number.isInteger(raw.generation) || (raw.generation as number) <= 0) throw new Error("DCP revision fence generation is invalid")
		if (typeof raw.payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.payloadHash)) throw new Error("DCP revision fence payload hash is invalid")
		return { generation: raw.generation as number, payloadHash: raw.payloadHash }
	} catch (error) {
		throw new DcpStateCorruptionError(error instanceof Error ? error.message : String(error))
	}
}

async function readRevisionFence(statePath: string, expectedSessionId?: string): Promise<RevisionFenceRead> {
	try {
		return {
			status: "valid",
			revision: decodeRevisionFence(await readFile(revisionFencePath(statePath), "utf8"), expectedSessionId),
		}
	} catch (error) {
		if (isMissingStateError(error)) return { status: "missing" }
		if (error instanceof DcpStateCorruptionError || !isFilesystemError(error)) {
			const corruption = error instanceof DcpStateCorruptionError
				? error
				: new DcpStateCorruptionError(error instanceof Error ? error.message : String(error))
			return { status: "corrupt", error: corruption }
		}
		throw error
	}
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
	// An unrelated session startup must not let an in-flight writer escape its queue.
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

export interface DcpPublicationOptions {
	/** Synchronous cancellation/owner/source guard, checked again at the rename boundary. */
	beforePublish?: () => void
	/** Non-throwing notification that the primary generation is now published. */
	onPublished?: () => void
}

async function atomicWriteStateFile(statePath: string, serializedText: string, publication?: DcpPublicationOptions): Promise<void> {
	const directory = dirname(statePath)
	await mkdir(directory, { recursive: true })
	const tempPath = `${statePath}.tmp-${Date.now()}-${++tempFileCounter}`
	let handle: Awaited<ReturnType<typeof open>> | undefined
	let published = false

	try {
		handle = await open(tempPath, "w", 0o600)
		await handle.writeFile(serializedText, "utf8")
		await handle.sync()
		await handle.close()
		handle = undefined
		publication?.beforePublish?.()
		await rename(tempPath, statePath)
		published = true
		publication?.onPublished?.()
		await syncDirectory(directory)
	} catch (error) {
		await handle?.close().catch(() => {})
		await unlink(tempPath).catch(() => {})
		// Rename is the point of no return. A later directory-sync/notification
		// failure cannot be reported as an ordinary failed, uncommitted operation.
		if (published && publication && await readFile(statePath, "utf8").then((text) => text === serializedText, () => false)) return
		throw error
	}
}

async function writeRevisionFence(statePath: string, sessionId: string, revision: DcpDiskRevision): Promise<void> {
	const fence = {
		kind: "dcp-state-fence",
		schemaVersion: 1,
		sessionId,
		generation: revision.generation,
		payloadHash: revision.payloadHash,
	}
	await atomicWriteStateFile(revisionFencePath(statePath), JSON.stringify(fence))
}

function recoveryBlockedError(statePath: string): DcpPersistenceConflictError {
	return new DcpPersistenceConflictError(
		`DCP state recovery is blocked for ${statePath}; refusing to overwrite an unrecovered generation`,
	)
}

async function hasRecoveryMarker(statePath: string): Promise<boolean> {
	try {
		await stat(recoveryMarkerPath(statePath))
		// The marker is deliberately fail-closed even when it was manually
		// replaced with a bad object. It exists solely to prevent a later process
		// from mistaking an unrecoverable sidecar for a new one.
		return true
	} catch (error) {
		if (isMissingStateError(error)) return false
		throw error
	}
}

async function markRecoveryBlocked(statePath: string, sessionId?: string): Promise<void> {
	const marker = {
		kind: "dcp-state-recovery-required",
		schemaVersion: 1,
		sessionId,
		createdAt: Date.now(),
	}
	await atomicWriteStateFile(recoveryMarkerPath(statePath), JSON.stringify(marker))
	recoveryBlockedPaths.add(statePath)
}

async function clearRecoveryBlocked(statePath: string): Promise<void> {
	recoveryBlockedPaths.delete(statePath)
	try {
		await unlink(recoveryMarkerPath(statePath))
		await syncDirectory(dirname(statePath))
	} catch (error) {
		if (isMissingStateError(error)) return
		throw error
	}
}

async function assertRecoveryIsNotBlocked(statePath: string): Promise<void> {
	if (recoveryBlockedPaths.has(statePath) || await hasRecoveryMarker(statePath)) {
		recoveryBlockedPaths.add(statePath)
		throw recoveryBlockedError(statePath)
	}
}

async function acceptLoadedState(
	statePath: string,
	decoded: DecodedStateDocument,
	ownerRevision?: DcpDiskRevision,
): Promise<SerializedDcpState> {
	lastPersistedStateHashByPath.set(statePath, hashSerializedState(decoded.payload))
	lastPersistedGenerationByPath.set(statePath, ownerRevision?.generation ?? decoded.generation)
	// A manually restored primary or valid .prev is the only thing that clears
	// a durable recovery marker. Loading never synthesizes a replacement file.
	await clearRecoveryBlocked(statePath)
	dcpDiskRevisions(decoded.payload).set(statePath, ownerRevision ?? {
		generation: decoded.generation,
		payloadHash: payloadSha256(decoded.payload),
	})
	return decoded.payload
}

async function quarantineCorruptState(statePath: string): Promise<string | undefined> {
	const quarantinePath = `${statePath}.corrupt-${Date.now()}-${++tempFileCounter}`
	try {
		const info = await stat(statePath)
		if (!info.isFile()) return undefined
		await rename(statePath, quarantinePath)
		await syncDirectory(dirname(statePath))
		return quarantinePath
	} catch (error) {
		if (isMissingStateError(error)) return undefined
		throw error
	}
}

async function loadStatePath(statePath: string, expectedSessionId?: string): Promise<SerializedDcpState | undefined> {
	const primary = await readStateDocument(statePath, expectedSessionId)
	if (primary.status === "valid") {
		const fence = await readRevisionFence(statePath, expectedSessionId)
		if (fence.status === "corrupt") return undefined
		if (fence.status === "valid") {
			const decoded = primary.decoded!
			const hash = payloadSha256(decoded.payload)
			if (fence.revision!.generation > decoded.generation) return undefined
			if (fence.revision!.generation === decoded.generation && fence.revision!.payloadHash !== hash) return undefined
		}
		return acceptLoadedState(statePath, primary.decoded!)
	}

	const previousPath = previousStatePath(statePath)
	const previous = await readStateDocument(previousPath, expectedSessionId)
	if (previous.status === "valid") {
		const fence = await readRevisionFence(statePath, expectedSessionId)
		if (fence.status === "corrupt") return undefined
		if (fence.status === "valid") {
			const decoded = previous.decoded!
			const hash = payloadSha256(decoded.payload)
			if (fence.revision!.generation > decoded.generation) {
				// A corrupt primary is an explicit recovery case: the valid .prev is the
				// payload source, while the durable fence remains the optimistic owner
				// revision so the next publication advances past the lost generation.
				// A merely missing primary is different: a fresh process cannot prove that
				// its older .prev payload owns the fenced newer revision.
				if (primary.status !== "corrupt") return undefined
				await quarantineCorruptState(statePath)
				return acceptLoadedState(statePath, decoded, fence.revision!)
			}
			if (fence.revision!.generation === decoded.generation && fence.revision!.payloadHash !== hash) return undefined
		}
		// Preserve the bad primary for inspection before a later normal save can
		// publish a new generation. Recovery itself never rewrites a sidecar.
		if (primary.status === "corrupt") await quarantineCorruptState(statePath)
		return acceptLoadedState(statePath, previous.decoded!)
	}

	if (primary.status === "corrupt" || previous.status === "corrupt") {
		// Persist this before moving corrupt files aside. The marker survives a
		// process restart, so an absent primary cannot be mistaken for a fresh
		// session and overwritten with empty state.
		await markRecoveryBlocked(statePath, expectedSessionId)
		if (primary.status === "corrupt") await quarantineCorruptState(statePath)
		if (previous.status === "corrupt") await quarantineCorruptState(previousPath)
		return undefined
	}

	if (await hasRecoveryMarker(statePath)) recoveryBlockedPaths.add(statePath)
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

	let sessionId: string | undefined
	try {
		sessionId = await readSessionIdFromFile(sessionFile)
	} catch {
		// A missing/unreadable previous session means there is nothing safe to inherit.
		return undefined
	}
	if (!sessionId) return undefined

	const stateDir = join(dirname(sessionFile), DCP_STATE_DIR)
	const statePath = join(stateDir, safeSessionFileName(sessionId))
	return loadStatePath(statePath, sessionId)
}

export async function cleanupStaleDcpStateFiles(ctx: ExtensionContext): Promise<number> {
	const stateDir = resolveDcpStateDir(ctx)
	const sessionDir = ctx.sessionManager.getSessionDir()
	if (!stateDir || !sessionDir) return 0
	const cleanupStartedAt = Date.now()

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
		try {
			const removed = await withInterprocessStateLock(statePath, async () => {
				// A sidecar created or replaced while this cleanup was taking its initial
				// session snapshot is not an orphan we can prove. Filesystem mtimes can be
				// coarse, so keep a small grace window around the cleanup start boundary.
				let info
				try {
					info = await stat(statePath)
				} catch (error) {
					if (isMissingStateError(error)) return false
					throw error
				}
				if (info.mtimeMs >= cleanupStartedAt - DCP_CLEANUP_MTIME_GRACE_MS) return false

				// Re-scan under the same lock used by writers. This closes the window where
				// a session JSONL and sidecar appear after the first listSessionIds() call.
				const refreshed = await listSessionIds(sessionDir)
				if (!refreshed.complete) return false
				const refreshedLive = new Set(refreshed.sessionIds.map(safeSessionFileName))
				const refreshedCurrentSessionId = ctx.sessionManager.getSessionId()
				if (refreshedCurrentSessionId) refreshedLive.add(safeSessionFileName(refreshedCurrentSessionId))
				if (refreshedLive.has(entry.name)) return false

				await unlink(statePath)
				await unlink(previousStatePath(statePath)).catch(() => {})
				await unlink(recoveryMarkerPath(statePath)).catch(() => {})
				await unlink(revisionFencePath(statePath)).catch(() => {})
				return true
			})
			if (removed) deleted++
		} catch (error) {
			// A live writer owning the lock is itself evidence that orphanhood is not
			// established. Cleanup is opportunistic, so skip rather than racing it.
			if (!(error instanceof DcpPersistenceConflictError)) throw error
		}
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
	await assertRecoveryIsNotBlocked(statePath)
	const cached = lastPersistedGenerationByPath.get(statePath)
	if (cached !== undefined) return cached

	const primary = await readStateDocument(statePath, sessionId)
	if (primary.status === "valid") {
		const decoded = primary.decoded!
		lastPersistedGenerationByPath.set(statePath, decoded.generation)
		lastPersistedStateHashByPath.set(statePath, hashSerializedState(decoded.payload))
		return decoded.generation
	}
	if (primary.status === "corrupt") {
		// save() is not a recovery operation. Refuse rather than silently using a
		// backup to overwrite a real corrupt primary that load() has not recovered.
		await markRecoveryBlocked(statePath, sessionId)
		throw recoveryBlockedError(statePath)
	}

	const previous = await readStateDocument(previousStatePath(statePath), sessionId)
	if (previous.status === "valid") {
		const decoded = previous.decoded!
		lastPersistedGenerationByPath.set(statePath, decoded.generation)
		return decoded.generation
	}
	if (previous.status === "corrupt") {
		await markRecoveryBlocked(statePath, sessionId)
		throw recoveryBlockedError(statePath)
	}
	return 0
}

async function backupCurrentGeneration(statePath: string, sessionId: string): Promise<void> {
	try {
		const text = await readBoundedStateText(statePath)
		decodeStateDocument(text, sessionId)
		await atomicWriteStateFile(previousStatePath(statePath), text)
	} catch (error) {
		if (isMissingStateError(error)) return
		if (error instanceof DcpStateCorruptionError) {
			await markRecoveryBlocked(statePath, sessionId)
			throw recoveryBlockedError(statePath)
		}
		throw error
	}
}

export async function saveDcpStateToTarget(target: DcpPersistenceTarget, state: DcpState, publication: DcpPublicationOptions = {}): Promise<void> {
	const statePath = target.statePath
	const sessionId = target.sessionId || fallbackSessionIdFromPath(statePath)
	publication.beforePublish?.()
	// Snapshot before the first await: later changes to live maps/arrays must
	// not leak into this generation or disagree with its payload hash.
	const serialized = serializeState(state)
	validateSerializedDcpState(serialized)
	const hash = hashSerializedState(serialized)
	const immutablePayload = JSON.parse(JSON.stringify(serialized)) as SerializedDcpState
	const payloadHash = payloadSha256(immutablePayload)
	const knownRevisions = dcpDiskRevisions(state)

	const previous = saveQueueByPath.get(statePath) ?? Promise.resolve()
	const saveQueue = previous
		.catch(() => {
			// Keep later saves moving even if an earlier write failed.
		})
		.then(async () => withInterprocessStateLock(statePath, async () => {
			publication.beforePublish?.()
			await assertRecoveryIsNotBlocked(statePath)
			const primary = await readStateDocument(statePath, sessionId)
			if (primary.status === "corrupt") {
				await markRecoveryBlocked(statePath, sessionId)
				throw recoveryBlockedError(statePath)
			}
			const current = primary.status === "valid" ? primary : await readStateDocument(previousStatePath(statePath), sessionId)
			if (current.status === "corrupt") {
				await markRecoveryBlocked(statePath, sessionId)
				throw recoveryBlockedError(statePath)
			}
			const currentRevision: DcpDiskRevision = current.decoded
				? { generation: current.decoded.generation, payloadHash: payloadSha256(current.decoded.payload) }
				: { generation: 0, payloadHash: "" }
			const fence = await readRevisionFence(statePath, sessionId)
			if (fence.status === "corrupt") {
				await markRecoveryBlocked(statePath, sessionId)
				throw recoveryBlockedError(statePath)
			}

			let diskRevision = currentRevision
			if (fence.status === "valid") {
				const fenced = fence.revision!
				if (fenced.generation === currentRevision.generation && fenced.payloadHash !== currentRevision.payloadHash) {
					await markRecoveryBlocked(statePath, sessionId)
					throw recoveryBlockedError(statePath)
				}
				if (fenced.generation > currentRevision.generation) diskRevision = fenced
				else if (currentRevision.generation > fenced.generation) {
					// The primary/previous document proves this newer revision actually
					// committed (for example, a crash after primary rename but before fence
					// publication). Repair the lagging fence before attempting another write.
					await writeRevisionFence(statePath, sessionId, currentRevision)
				}
			} else if (currentRevision.generation > 0) {
				// Upgrade older sidecars lazily. A fence is only synthesized from a
				// concrete durable generation, never from an in-memory owner token.
				await writeRevisionFence(statePath, sessionId, currentRevision)
			}

			const diskGeneration = diskRevision.generation
			const diskHash = diskRevision.payloadHash
			const expected = knownRevisions.get(statePath)
			if (expected ? expected.generation !== diskGeneration || expected.payloadHash !== diskHash : diskGeneration !== 0 || diskHash !== "") {
				if (expected && diskGeneration === 0 && diskHash === "" && fence.status === "missing") {
					// A runtime owner proves that durable state existed, but every revision
					// artifact has disappeared. Persist that fact before returning the stale
					// conflict so a restart cannot forget the owner token and misclassify this
					// as a brand-new session. Recovery requires a restored sidecar/.prev or a
					// surviving revision fence; never synthesize ownership from expected alone.
					await markRecoveryBlocked(statePath, sessionId)
				}
				throw new DcpPersistenceConflictError(
					`Stale DCP state revision at ${statePath}: expected generation ${expected?.generation ?? "unobserved"}, found ${diskGeneration}; reload before retry`,
				)
			}
			publication.beforePublish?.()
			if (payloadHash === diskHash && primary.status === "valid") return
			const generation = diskGeneration + 1
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
			publication.beforePublish?.()
			await atomicWriteStateFile(statePath, JSON.stringify(envelope), publication)
			const committedRevision = { generation, payloadHash }
			knownRevisions.set(statePath, committedRevision)
			lastPersistedStateHashByPath.set(statePath, hash)
			lastPersistedGenerationByPath.set(statePath, generation)
			// The primary rename is the commit point. The fence is a durable high-water
			// mark used only when primary/.prev later disappear. A fence write failure
			// after commit must not be reported as an uncommitted transaction; the next
			// save can safely repair it from the still-present primary generation.
			await writeRevisionFence(statePath, sessionId, committedRevision).catch(() => {})
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
