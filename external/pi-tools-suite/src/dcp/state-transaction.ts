import type { DcpState } from "./state.js"
import { createHash } from "node:crypto"

/**
 * Serialize all stateful DCP publications which share one live state object.
 *
 * Persistence has its own per-path queue, but that queue cannot protect the
 * read/plan/publish interval: two callers can otherwise both clone `nextBlockId
 * === 1`, persist independent snapshots, and both report success for b1.  This
 * queue deliberately spans preparation, durable publication, and the final
 * in-memory commit.
 */
const transactionTails = new WeakMap<DcpState, Promise<void>>()

export async function runDcpStateTransaction<T>(
  state: DcpState,
  operation: () => Promise<T> | T,
): Promise<T> {
  const previous = transactionTails.get(state) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  transactionTails.set(state, tail)

  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (transactionTails.get(state) === tail) transactionTails.delete(state)
  }
}

/** Runtime ownership changes invalidate any detached compression plan. */
export function invalidateDcpStateOwner(state: DcpState): number {
  state.sessionEpoch = Math.max(1, Math.floor(state.sessionEpoch || 0) + 1)
  return state.sessionEpoch
}

export function cloneDcpTransactionState(state: DcpState): DcpState {
  return structuredClone(state)
}

function canonicalRuntimeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "undefined") return "[undefined]"
  if (Array.isArray(value)) return value.map((item) => canonicalRuntimeValue(item, seen))
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, item]) => [canonicalRuntimeValue(key, seen), canonicalRuntimeValue(item, seen)] as const)
      .sort(([a], [b]) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }
  if (value instanceof Set) {
    return [...value.values()]
      .map((item) => canonicalRuntimeValue(item, seen))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[cycle]"
    seen.add(value as object)
    const record = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) result[key] = canonicalRuntimeValue(record[key], seen)
    seen.delete(value as object)
    return result
  }
  return String(value)
}

function transactionRevision(state: DcpState): string {
  return createHash("sha256").update(JSON.stringify(canonicalRuntimeValue(state))).digest("hex")
}

/** Capture ownership before queuing, never after a long await. */
export function captureDcpTransactionGuard(
  state: DcpState,
  config: unknown,
  signal?: AbortSignal,
  context?: any,
): () => void {
  const epoch = state.sessionEpoch
  const revision = transactionRevision(state)
  const configRevision = JSON.stringify(config)
  const contextRevision = () => JSON.stringify({
    session: context?.sessionManager?.getSessionId?.(),
    branch: context?.sessionManager?.getBranch?.(),
    model: context?.model,
    cwd: context?.cwd,
  })
  const owner = contextRevision()
  return () => {
    signal?.throwIfAborted()
    if (state.sessionEpoch !== epoch || transactionRevision(state) !== revision ||
      JSON.stringify(config) !== configRevision || contextRevision() !== owner) {
      throw new Error("stale_plan: DCP session, branch, model, configuration or source revision changed before publication")
    }
  }
}
