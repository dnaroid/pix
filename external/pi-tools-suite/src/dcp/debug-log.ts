import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { DcpConfig } from "./config.js"
import type { DcpState } from "./state.js"

const TRUE_ENV_RE = /^(1|true|yes|on)$/i
const FALSE_ENV_RE = /^(0|false|no|off)$/i
const MAX_IDS = 16
const DEFAULT_DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const DEFAULT_DEBUG_LOG_MAX_BACKUPS = 3
const MIN_DEBUG_LOG_MAX_BACKUPS = 1

function truthyEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (TRUE_ENV_RE.test(trimmed)) return true
  if (FALSE_ENV_RE.test(trimmed)) return false
  return undefined
}

export function dcpDebugEnabled(config: DcpConfig): boolean {
  return truthyEnv(process.env.PI_DCP_DEBUG)
    ?? truthyEnv(process.env.PI_TOOLS_SUITE_DCP_DEBUG)
    ?? config.debug
}

function defaultLogPath(): string {
  const agentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  return path.join(agentDir, "dcp-debug.jsonl")
}

function dcpDebugLogPath(): string {
  const explicit = process.env.PI_DCP_DEBUG_LOG?.trim()
  return explicit || defaultLogPath()
}

function positiveIntEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/** Maximum size the active debug log is allowed to reach before it is rotated. */
export function dcpDebugLogMaxBytes(config: DcpConfig): number {
  return positiveIntEnv(process.env.PI_DCP_DEBUG_MAX_BYTES)
    ?? config.debugLog?.maxBytes
    ?? DEFAULT_DEBUG_LOG_MAX_BYTES
}

/** Number of rotated backups to keep (e.g. `.1`, `.2`, `.3`). */
export function dcpDebugLogMaxBackups(config: DcpConfig): number {
  const value = positiveIntEnv(process.env.PI_DCP_DEBUG_MAX_BACKUPS)
    ?? config.debugLog?.maxBackups
    ?? DEFAULT_DEBUG_LOG_MAX_BACKUPS
  return Math.max(MIN_DEBUG_LOG_MAX_BACKUPS, Math.floor(value))
}

function compactIds(ids: string[]): { count: number; head: string[]; tail: string[] } {
  return {
    count: ids.length,
    head: ids.slice(0, MAX_IDS),
    tail: ids.length > MAX_IDS ? ids.slice(-MAX_IDS) : [],
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sessionInfo(ctx: ExtensionContext | undefined): Record<string, unknown> {
  if (!ctx) return {}
  const info: Record<string, unknown> = {}
  try {
    const header = (ctx as any).sessionManager?.getHeader?.()
    if (header?.id) info.sessionId = header.id
    if (header?.cwd) info.cwd = header.cwd
  } catch (error) {
    info.sessionInfoError = safeError(error)
  }
  try {
    const name = (ctx as any).sessionManager?.getSessionName?.()
    if (name) info.sessionName = name
  } catch {
    // Optional diagnostic only.
  }
  return info
}

export function summarizeDcpState(state: DcpState): Record<string, unknown> {
  const rawIds = [...new Set([
    ...state.messageIdSnapshot.keys(),
    ...state.messageMetaSnapshot.keys(),
  ])]
  const activeBlocks = state.compressionBlocks
    .filter((block) => block.active)
    .sort((a, b) => a.id - b.id)
    .map((block) => ({
      id: `b${block.id}`,
      topic: block.topic,
      mode: block.mode,
      startMessageId: block.startMessageId,
      endMessageId: block.endMessageId,
      anchorMessageId: block.anchorMessageId,
      coveredBlockIds: block.coveredBlockIds ?? [],
      summaryTokens: block.summaryTokenEstimate,
    }))
  const inactiveBlocks = state.compressionBlocks
    .filter((block) => !block.active)
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_IDS)
    .map((block) => ({
      id: `b${block.id}`,
      topic: block.topic,
      reason: block.deactivatedReason,
      coveredBlockIds: block.coveredBlockIds ?? [],
    }))

  return {
    rawIds: compactIds(rawIds),
    activeBlocks,
    blockCounts: {
      active: activeBlocks.length,
      inactive: state.compressionBlocks.length - activeBlocks.length,
      total: state.compressionBlocks.length,
      nextBlockId: state.nextBlockId,
    },
    inactiveBlocksTail: inactiveBlocks,
    prunedTools: state.prunedToolIds.size,
    providerSeenTools: state.providerSeenToolIds.size,
    consecutiveEmergencyPasses: state.consecutiveIgnoredStrongNudges,
    nudgeAnchors: state.nudgeAnchors.map((anchor) => ({
      id: anchor.id,
      type: anchor.type,
      anchorStableId: anchor.anchorStableId,
      anchorTimestamp: anchor.anchorTimestamp,
    })),
  }
}

// Serializes all debug-log writes so rotation and appends never race.
let logWriteChain: Promise<void> = Promise.resolve()
const ensuredLogDirs = new Set<string>()

async function ensureLogDir(logPath: string): Promise<void> {
  const dir = path.dirname(logPath)
  if (ensuredLogDirs.has(dir)) return
  await fs.mkdir(dir, { recursive: true })
  ensuredLogDirs.add(dir)
}

/**
 * When the active log has reached `maxBytes`, rotate numbered backups:
 * drop `.N`, shift `.(N-1)`→`.N`, …, `.1`→`.2`, and rename the active file to
 * `.1` so the next append starts a fresh file. Best-effort: fs errors are
 * swallowed because debug logging must never affect the session.
 */
async function rotateDebugLogIfNeeded(
  logPath: string,
  maxBytes: number,
  maxBackups: number,
): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(logPath)
  } catch {
    return // active file does not exist yet; nothing to rotate
  }
  if (stat.size < maxBytes) return

  const dir = path.dirname(logPath)
  const base = path.basename(logPath)

  // Drop the oldest backup (`base.N`) so the chain can shift up by one.
  await fs.rm(path.join(dir, `${base}.${maxBackups}`), { force: true })
  // Shift existing backups `base.i` → `base.(i+1)` from highest to lowest.
  for (let i = maxBackups - 1; i >= 1; i--) {
    await fs
      .rename(path.join(dir, `${base}.${i}`), path.join(dir, `${base}.${i + 1}`))
      .catch(() => {
        // A missing intermediate backup is expected; ignore.
      })
  }
  // Rotate the active file into `base.1`.
  await fs.rename(logPath, path.join(dir, `${base}.1`)).catch(() => {
    // If we cannot move the active file, truncate it so growth is bounded.
    void fs.truncate(logPath, 0).catch(() => {})
  })
}

async function appendDebugLogRecord(
  logPath: string,
  record: Record<string, unknown>,
  maxBytes: number,
  maxBackups: number,
): Promise<void> {
  await ensureLogDir(logPath)
  await rotateDebugLogIfNeeded(logPath, maxBytes, maxBackups)
  await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8")
}

export function writeDcpDebugLog(
  config: DcpConfig,
  event: string,
  details: Record<string, unknown> = {},
  ctx?: ExtensionContext,
): void {
  if (!dcpDebugEnabled(config)) return

  const record = {
    ts: new Date().toISOString(),
    event,
    ...sessionInfo(ctx),
    ...details,
  }

  const logPath = dcpDebugLogPath()
  const maxBytes = dcpDebugLogMaxBytes(config)
  const maxBackups = dcpDebugLogMaxBackups(config)

  // Serialize writes so concurrent records append in order and rotation is safe.
  logWriteChain = logWriteChain
    .then(() => appendDebugLogRecord(logPath, record, maxBytes, maxBackups))
    .catch(() => {
      // Debug logging must never affect the session or tool outcome.
    })
}

/**
 * Resolves when all queued debug-log writes (and rotations) have settled. Useful
 * for flushing before shutdown and for deterministic test assertions.
 */
export function dcpDebugLogDrain(): Promise<void> {
  return logWriteChain
}
