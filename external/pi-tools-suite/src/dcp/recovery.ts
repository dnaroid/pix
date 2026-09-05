import { createInputFingerprint, type DcpState, type ToolRecord } from "./state.js"
import { estimateMessageTokens, messageText } from "./pruner-metadata.js"

export interface DcpToolRecordRehydration {
  recordsUpdated: number
  exactArgsRestored: number
  exactOutputsRestored: number
}

function assistantToolCalls(message: any): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return []
  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
  for (const part of message.content) {
    if (!part || part.type !== "toolCall" || typeof part.id !== "string") continue
    const name = typeof part.name === "string"
      ? part.name
      : typeof part.function?.name === "string"
        ? part.function.name
        : ""
    const rawInput = part.input ?? part.arguments ?? part.function?.arguments
    let input: Record<string, unknown> = {}
    if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
      input = rawInput as Record<string, unknown>
    } else if (typeof rawInput === "string") {
      try {
        const parsed = JSON.parse(rawInput)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed
      } catch {
        // Keep opaque/non-JSON provider arguments out of structured recovery.
      }
    }
    calls.push({ id: part.id, name, input })
  }
  return calls
}

function hasRestoredOnlyArgs(record: ToolRecord): boolean {
  const keys = Object.keys(record.inputArgs ?? {})
  return keys.length === 0 || (keys.length === 1 && keys[0] === "_restoredValues")
}

/**
 * Rehydrate exact, ephemeral tool metadata from the raw session context after
 * loading the compact sidecar. This never changes provider evidence and never
 * creates records for IDs that were trimmed from the persisted cache; absence
 * from that cache therefore remains "unknown", not evidence of freshness/seen.
 */
export function rehydrateToolRecordsFromMessages(
  messages: any[],
  state: DcpState,
): DcpToolRecordRehydration {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>()
  for (const message of messages) {
    for (const call of assistantToolCalls(message)) calls.set(call.id, { name: call.name, input: call.input })
  }

  let recordsUpdated = 0
  let exactArgsRestored = 0
  let exactOutputsRestored = 0
  const touched = new Set<string>()

  for (const [toolCallId, record] of state.toolCalls) {
    const call = calls.get(toolCallId)
    if (call && hasRestoredOnlyArgs(record) && Object.keys(call.input).length > 0) {
      record.inputArgs = call.input
      if (call.name) record.toolName = call.name
      record.inputFingerprint = createInputFingerprint(record.toolName, call.input)
      exactArgsRestored++
      touched.add(toolCallId)
    }
  }

  for (const message of messages) {
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue
    const record = state.toolCalls.get(message.toolCallId)
    if (!record) continue
    const text = messageText(message).trim()
    if (!record.outputText && text) {
      record.outputText = text
      exactOutputsRestored++
      touched.add(message.toolCallId)
    }
    if (typeof message.toolName === "string" && message.toolName) record.toolName = message.toolName
    if (typeof message.isError === "boolean") record.isError = message.isError
    if (Number.isFinite(message.timestamp)) record.timestamp = message.timestamp
    record.tokenEstimate = Math.max(record.tokenEstimate ?? 0, estimateMessageTokens(message))
  }

  recordsUpdated = touched.size
  return { recordsUpdated, exactArgsRestored, exactOutputsRestored }
}
