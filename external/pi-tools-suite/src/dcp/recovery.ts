import { createInputFingerprint, type DcpState, type ToolRecord } from "./state.js"
import { estimateMessageTokens, messageText } from "./pruner-metadata.js"

export interface DcpToolRecordRehydration {
  recordsUpdated: number
  exactArgsRestored: number
  exactOutputsRestored: number
}

interface RawToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  turnIndex: number
  timestamp: number
}

function assistantToolCalls(message: any, turnIndex: number): RawToolCall[] {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return []
  const calls: RawToolCall[] = []
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
    calls.push({
      id: part.id,
      name,
      input,
      turnIndex,
      timestamp: Number.isFinite(message.timestamp) ? message.timestamp : 0,
    })
  }
  return calls
}

function hasRestoredOnlyArgs(record: ToolRecord): boolean {
  const keys = Object.keys(record.inputArgs ?? {})
  return keys.length === 0 || (keys.length === 1 && keys[0] === "_restoredValues")
}

/**
 * Rebuild exact, ephemeral tool metadata from the raw session branch.
 *
 * The journal intentionally persists only projection decisions, not tool
 * outputs or delivery evidence. After restart this function reconstructs the
 * tool records needed for protection/fingerprinting from raw history while
 * leaving `providerSeenToolIds` untouched. Absence of provider evidence after
 * restart therefore remains "unknown" and cannot authorize emergency pruning.
 */
export function rehydrateToolRecordsFromMessages(
  messages: any[],
  state: DcpState,
): DcpToolRecordRehydration {
  const calls = new Map<string, RawToolCall>()
  let turnIndex = 0
  for (const message of messages) {
    if (message?.role === "user") turnIndex++
    for (const call of assistantToolCalls(message, turnIndex)) calls.set(call.id, call)
  }

  let recordsUpdated = 0
  let exactArgsRestored = 0
  let exactOutputsRestored = 0
  const touched = new Set<string>()

  for (const message of messages) {
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue
    const call = calls.get(message.toolCallId)
    const text = messageText(message).trim()
    const toolName = call?.name || (typeof message.toolName === "string" ? message.toolName : "")
    let record = state.toolCalls.get(message.toolCallId)
    if (!record) {
      const inputArgs = call?.input ?? {}
      record = {
        toolCallId: message.toolCallId,
        toolName,
        inputArgs,
        inputFingerprint: createInputFingerprint(toolName, inputArgs),
        isError: message.isError === true,
        turnIndex: call?.turnIndex ?? turnIndex,
        timestamp: Number.isFinite(message.timestamp) ? message.timestamp : call?.timestamp ?? 0,
        tokenEstimate: estimateMessageTokens(message),
        ...(text ? { outputText: text } : {}),
        ...(message.details !== undefined ? { outputDetails: message.details } : {}),
      }
      state.toolCalls.set(message.toolCallId, record)
      if (Object.keys(inputArgs).length > 0) exactArgsRestored++
      if (text) exactOutputsRestored++
      touched.add(message.toolCallId)
      continue
    }
    if (call && hasRestoredOnlyArgs(record) && Object.keys(call.input).length > 0) {
      record.inputArgs = call.input
      if (call.name) record.toolName = call.name
      record.inputFingerprint = createInputFingerprint(record.toolName, call.input)
      record.turnIndex = call.turnIndex
      exactArgsRestored++
      touched.add(message.toolCallId)
    }
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
  state.totalToolCallCount = Math.max(state.totalToolCallCount, state.toolCalls.size)
  return { recordsUpdated, exactArgsRestored, exactOutputsRestored }
}
