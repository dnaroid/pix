import type { DcpState } from "./state.js"
import { serializeState } from "./state.js"
import { createHash } from "node:crypto"
import { shareDcpDiskRevisions } from "./persistence-ownership.js"

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
  const clone = structuredClone(state)
  shareDcpDiskRevisions(state, clone)
  return clone
}

function transactionRevision(state: DcpState): string {
  return createHash("sha256").update(JSON.stringify({
    persisted: serializeState(state),
    source: state.conversationIndexSnapshot,
  })).digest("hex")
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
