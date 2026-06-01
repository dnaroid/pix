// ---------------------------------------------------------------------------
// DCP TUI Filter — strips DCP metadata tags from assistant chat messages
// ---------------------------------------------------------------------------
// The DCP context handler injects markdown reference marker lines such as
// [dcp-id]: # (m001) plus <dcp-system-reminder> tags into the context copy
// sent to the LLM. The LLM sometimes echoes this metadata back. This module
// strips them from streaming/displayed assistant messages so the TUI stays clean.
//
// We filter ASSISTANT messages only. User and toolResult messages are not
// mutated because message_end replacement persists to the session — stripping
// real content that happens to contain DCP-like tags would be irreversible.
// DCP tags in user/toolResult messages are injected only into context copies
// (by injectMessageIds) and are never stored, so they never reach the TUI.
//
// Tags are re-injected on every context event (before each LLM call),
// so stripping from stored messages is safe — the agent always sees them.
// ---------------------------------------------------------------------------

import {
  AssistantMessageComponent,
  BashExecutionComponent,
  CustomMessageComponent,
  type ExtensionAPI,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@mariozechner/pi-coding-agent"

// ---------------------------------------------------------------------------
// Regex patterns — broad opencode-style catch-all for ANY <dcp*> tag
// ---------------------------------------------------------------------------

/** Matches any paired DCP tag: <dcp-anything>...</dcp-anything> (non-greedy). */
const DCP_PAIRED_TAG_RE = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi

/** Matches any unpaired/orphan opening or closing DCP tag fragment. */
const DCP_UNPAIRED_TAG_RE = /<\/?dcp[^>]*>/gi

/** Matches markdown reference marker lines such as `[dcp-id]: # (m156)`. */
const DCP_MARKDOWN_REF_LINE_RE = /^\s*\[dcp[^\]]*\]:\s*#(?:\s*\([^)]*\)|\s+"[^"]*"|\s+'[^']*')?(?:\s+priority=(?:low|medium|high))?\s*$/gim

/** Matches malformed/truncated DCP markdown marker lines at line start. */
const DCP_MARKDOWN_REF_FRAGMENT_LINE_RE = /^\s*\[dcp[^\n]*$/gim

/**
 * Streaming only: matches a DCP markdown reference marker line that has started
 * but may not be complete yet, e.g. `[dcp-id]:`, `[dcp-id]: # (m023`, or
 * legacy `[dcp-id]: # (m023) priority=` at the end of the current assistant text.
 */
const DCP_MARKDOWN_REF_TO_END_RE = /(^|\n)\s*\[dcp[^\n]*$/i

/**
 * Streaming only: matches an open DCP tag followed by content to the end
 * of text, where the closing tag hasn't arrived yet.
 * e.g. `<dcp-id>m156` or `<dcp-foo>some content here`
 *
 * IMPORTANT: must be applied BEFORE DCP_UNPAIRED_TAG_RE in streaming mode,
 * because unpaired would strip just the `<dcp-id>` part, leaving `m156`
 * stranded in the output.
 */
const DCP_OPEN_TAG_TO_END_RE = /<dcp[^>]*>[\s\S]*$/gi

/**
 * Streaming only: matches an incomplete DCP tag prefix at the end of text.
 *
 * Providers can split a tag at any byte/token boundary, so the UI may briefly
 * see `<`, `<d`, `<dc`, `<dcp`, or `<dcp-id` before the full opening tag is
 * available. Hide those suffixes during streaming only.
 */
const DCP_INCOMPLETE_OPEN_RE = /(?:<|<\/?d|<\/?dc|<\/?dcp(?:[^<>\n]*)?)$/i

/** Case-insensitive quick check — is there anything DCP-shaped in this text? */
const DCP_QUICK_CHECK_RE = /<\/?d(?:c(?:p)?)?|\[dcp|dcp/i

type StreamTextKind = "text" | "thinking"

const RENDER_PATCH_FLAG = Symbol.for("pi-tools-suite.dcpTuiFilter.renderPatch")
const DISPLAY_RENDER_PATCH_FLAG = Symbol.for("pi-tools-suite.dcpTuiFilter.displayRenderPatch")

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g
const RENDERED_DCP_METADATA_RE = /\[dcp[^\]]*\]:\s*#|<\/?dcp-system-reminder\b/i
const RENDERED_DCP_CONTINUATION_RE = /^(?:#\s*)?\(?(?:m\d+|b\d+)\)?(?:\s+priority=(?:low|medium|high)\)?)?$|^priority=?$|^(?:low|medium|high)\)?$/i

// ---------------------------------------------------------------------------
// Tag stripping
// ---------------------------------------------------------------------------

/**
 * Strip all DCP metadata tags from a text string.
 *
 * Uses two broad regexes (matching opencode's approach):
 * 1. Paired tags: <dcp-anything>content</dcp-anything>
 * 2. Unpaired/orphan: any remaining <dcp...> or </dcp...> fragments
 *
 * During streaming, also hides:
 * - Open DCP tags with trailing content (no closing tag yet)
 * - Incomplete tag prefixes at end of text
 *
 * Returns the cleaned text, or the original if no tags were found.
 */
export function stripDcpTags(
  text: string,
  options: { streaming?: boolean } = {},
): string {
  if (!text || !DCP_QUICK_CHECK_RE.test(text)) return text

  // 1. Strip markdown reference marker lines, then fully paired XML tags
  let cleaned = text
    .replace(DCP_MARKDOWN_REF_LINE_RE, "")
    .replace(DCP_MARKDOWN_REF_FRAGMENT_LINE_RE, "")
    .replace(DCP_PAIRED_TAG_RE, "")

  if (options.streaming) {
    // 2. In streaming: strip open tags to end of text BEFORE unpaired,
    //    so that `<dcp-id>m156` is removed as a whole unit rather than
    //    having unpaired strip just `<dcp-id>` and leaving `m156` stranded
    cleaned = cleaned
      .replace(DCP_MARKDOWN_REF_TO_END_RE, "$1")
      .replace(DCP_OPEN_TAG_TO_END_RE, "")
  }

  // 3. Strip any remaining orphan opening/closing tags
  cleaned = cleaned.replace(DCP_UNPAIRED_TAG_RE, "")

  if (options.streaming) {
    // 4. Strip incomplete tag prefixes at end of streaming text
    cleaned = cleaned.replace(DCP_INCOMPLETE_OPEN_RE, "")
  }

  return cleaned
    .replace(/\n{3,}/g, "\n\n") // collapse excessive blank lines
    .trimEnd()
}

export function stripDcpRenderedLines(lines: string[]): string[] {
  const cleaned: string[] = []
  let droppingWrappedMetadata = false

  for (const line of lines) {
    const plain = line.replace(ANSI_RE, "").trim()
    if (RENDERED_DCP_METADATA_RE.test(plain)) {
      droppingWrappedMetadata = true
      continue
    }

    if (droppingWrappedMetadata && RENDERED_DCP_CONTINUATION_RE.test(plain)) {
      continue
    }

    droppingWrappedMetadata = false
    cleaned.push(line)
  }

  return cleaned
}

// ---------------------------------------------------------------------------
// Content block helpers
// ---------------------------------------------------------------------------

/**
 * Strip DCP tags from a single content block (text or thinking).
 * Returns [block, modified] tuple. Block is undefined if it should be dropped.
 */
function stripBlock(block: any, streaming = false): [any, boolean] {
  if (!block || typeof block !== "object") return [block, false]

  let modified = false
  let next = block

  // Text blocks
  if (typeof block.text === "string") {
    const cleaned = stripDcpTags(block.text, { streaming })
    if (cleaned !== block.text) {
      modified = true
      if (cleaned.trim() === "" && block.type === "text") return [undefined, true]
      next = { ...block, text: cleaned }
    }
  }

  // Thinking blocks
  if (typeof block.thinking === "string") {
    const cleaned = stripDcpTags(block.thinking, { streaming })
    if (cleaned !== block.thinking) {
      modified = true
      if (cleaned.trim() === "" && block.type === "thinking") return [undefined, true]
      next = { ...next, thinking: cleaned }
    }
  }

  // Delete stale signatures when content was modified. Providers verify
  // textSignature/thinkingSignature against the exact content — a mismatch
  // causes rejection. Mirrors the existing DCP metadata stripper pattern
  // in pruner-metadata.ts:stripStaleDcpMetadataFromAssistantBlock.
  if (modified) {
    if ("textSignature" in next) {
      const { textSignature: _, ...rest } = next
      next = rest
    }
    if ("thinkingSignature" in next) {
      const { thinkingSignature: _, ...rest } = next
      next = rest
    }
  }

  return [next, modified]
}

/**
 * Strip DCP tags from an assistant message's content.
 * Returns the cleaned message (shallow copy if modified, original if clean).
 */
function stripDcpFromAssistantMessage(message: any, streaming = false): any {
  if (!message || typeof message !== "object") return message

  const content = message.content
  if (!content) return message

  // String content
  if (typeof content === "string") {
    const cleaned = stripDcpTags(content, { streaming })
    if (cleaned === content) return message
    return { ...message, content: cleaned }
  }

  // Array content (Anthropic-style content blocks)
  if (!Array.isArray(content)) return message

  let modified = false
  const newContent = content
    .map((block: any) => {
      const [cleaned, wasModified] = stripBlock(block, streaming)
      if (wasModified) modified = true
      return cleaned
    })
    .filter((block: any) => block !== undefined)

  if (!modified) return message
  return { ...message, content: newContent }
}

/**
 * Mutate the shallow event message object that Pi sends to TUI/listeners.
 *
 * `message_update` has no return-value replacement API, but Pi emits extension
 * events before TUI listeners and passes the same shallow event message object
 * onward. Replacing `message.content` here cleans the rendered stream without
 * mutating the provider's raw partial/final assistant message object.
 */
function stripDcpFromAssistantMessageInPlace(message: any, streaming = false): boolean {
  const cleaned = stripDcpFromAssistantMessage(message, streaming)
  if (cleaned === message) return false

  Object.assign(message as Record<string, unknown>, cleaned)
  return true
}

/**
 * Patch Pi's assistant renderer as a final display-only safety net.
 *
 * Extension `message_update` handlers can sanitize the event message, but some
 * live/render paths have historically shown raw text before or instead of the
 * sanitized event object. Patching AssistantMessageComponent means any
 * assistant text/thinking content is stripped immediately before TUI rendering,
 * without mutating the stored session message or the provider-visible context.
 */
function registerAssistantRenderPatch(): void {
  const prototype = AssistantMessageComponent?.prototype as Record<string | symbol, any> | undefined
  if (!prototype || prototype[RENDER_PATCH_FLAG]) return

  const originalUpdateContent = prototype.updateContent
  if (typeof originalUpdateContent !== "function") return

  Object.defineProperty(prototype, RENDER_PATCH_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
  })

  prototype.updateContent = function updateContentWithDcpFilter(message: any): void {
    const cleaned = stripDcpFromAssistantMessage(message, true)
    return originalUpdateContent.call(this, cleaned)
  }
}

function patchRenderedLines(componentClass: unknown): void {
  const prototype = (componentClass as any)?.prototype as Record<string | symbol, any> | undefined
  if (!prototype || prototype[DISPLAY_RENDER_PATCH_FLAG]) return

  const originalRender = prototype.render
  if (typeof originalRender !== "function") return

  Object.defineProperty(prototype, DISPLAY_RENDER_PATCH_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
  })

  prototype.render = function renderWithDcpLineFilter(width: number): string[] {
    const lines = originalRender.call(this, width)
    return Array.isArray(lines) ? stripDcpRenderedLines(lines) : lines
  }
}

function registerDisplayRenderPatches(): void {
  patchRenderedLines(UserMessageComponent)
  patchRenderedLines(CustomMessageComponent)
  patchRenderedLines(ToolExecutionComponent)
  patchRenderedLines(BashExecutionComponent)
}

function getAssistantBlockString(message: any, contentIndex: number, kind: StreamTextKind): string | undefined {
  const content = message?.content
  if (!Array.isArray(content)) return undefined

  const block = content[contentIndex]
  if (!block || typeof block !== "object") return undefined

  const value = block[kind]
  return typeof value === "string" ? value : undefined
}

function streamStateKey(kind: StreamTextKind, contentIndex: number): string {
  return `${kind}:${contentIndex}`
}

/**
 * Keep low-level streaming events in sync with the sanitized display message.
 *
 * The Pi TUI reads `event.message`, but RPC/proxy clients may render from
 * `assistantMessageEvent.delta` or `.partial`. If those fields keep the raw
 * provider chunks, DCP tags can still flash even though the TUI message copy is
 * clean. Mutate nested assistant event fields in place: AgentSession passes the
 * same nested `assistantMessageEvent` object to extension handlers and TUI
 * listeners, but replacing the top-level extension event object does not flow
 * back to the original AgentSession event.
 */
function sanitizeAssistantMessageEvent(event: any, streamTextByKey: Map<string, string>): void {
  const assistantEvent = event?.assistantMessageEvent
  if (!assistantEvent || typeof assistantEvent !== "object") return

  const rawPartial = assistantEvent.partial
  const cleanedPartial = stripDcpFromAssistantMessage(rawPartial, true)

  if (cleanedPartial !== rawPartial) {
    assistantEvent.partial = cleanedPartial
  }

  const type = assistantEvent.type
  if (
    (type === "text_start" || type === "text_delta" || type === "text_end") &&
    typeof assistantEvent.contentIndex === "number"
  ) {
    sanitizeTextStreamEvent(
      assistantEvent,
      cleanedPartial,
      "text",
      streamTextByKey,
    )
  } else if (
    (type === "thinking_start" || type === "thinking_delta" || type === "thinking_end") &&
    typeof assistantEvent.contentIndex === "number"
  ) {
    sanitizeTextStreamEvent(
      assistantEvent,
      cleanedPartial,
      "thinking",
      streamTextByKey,
    )
  } else if (type === "start") {
    streamTextByKey.clear()
  }
}

function sanitizeTextStreamEvent(
  assistantEvent: any,
  cleanedPartial: any,
  kind: StreamTextKind,
  streamTextByKey: Map<string, string>,
): void {
  const contentIndex = assistantEvent.contentIndex as number
  const key = streamStateKey(kind, contentIndex)
  const cleanedFullText = getAssistantBlockString(cleanedPartial, contentIndex, kind) ?? ""

  if (assistantEvent.type === `${kind}_start`) {
    streamTextByKey.set(key, cleanedFullText)
    return
  }

  if (assistantEvent.type === `${kind}_delta`) {
    const previousText = streamTextByKey.get(key) ?? ""
    const cleanedDelta = cleanedFullText.startsWith(previousText)
      ? cleanedFullText.slice(previousText.length)
      : cleanedFullText

    streamTextByKey.set(key, cleanedFullText)

    if (cleanedDelta !== assistantEvent.delta) {
      assistantEvent.delta = cleanedDelta
    }
    return
  }

  if (assistantEvent.type === `${kind}_end`) {
    streamTextByKey.set(key, cleanedFullText)
    if (typeof assistantEvent.content === "string") {
      const cleanedContent = stripDcpTags(assistantEvent.content)
      if (cleanedContent !== assistantEvent.content) {
        assistantEvent.content = cleanedContent
      }
    }
  }
}

/**
 * Best-effort in-memory cleanup for assistant messages that were persisted by
 * older filter versions before `message_end` stripping existed/worked. This is
 * intentionally assistant-only for the same safety reasons as the live filter.
 */
function scrubAssistantMessagesInSessionHistory(sessionManager: any): void {
  const entries = sessionManager?.getEntries?.()
  if (!Array.isArray(entries)) return

  for (const entry of entries) {
    if (!entry || entry.type !== "message") continue

    const msg = entry.message
    if (!msg || msg.role !== "assistant") continue

    const cleaned = stripDcpFromAssistantMessage(msg)
    if (cleaned !== msg) {
      Object.assign(msg as Record<string, unknown>, cleaned)
    }
  }
}

// ---------------------------------------------------------------------------
// Extension hook
// ---------------------------------------------------------------------------

/**
 * Register the DCP TUI filter on the given extension API.
 *
 * Hooks into both streaming `message_update` and finalized `message_end`:
 * - `message_update` prevents tags from flashing in the TUI while tokens stream
 * - `message_end` keeps stored assistant messages clean
 *
 * We only filter assistant messages because:
 * - DCP tags in user/toolResult are only added to context copies, never stored
 * - Mutating user/toolResult via message_end persists permanently and could
 *   corrupt legitimate content that happens to contain DCP-like text
 * - The LLM is the only source of echoed DCP tags in stored messages
 */
export function registerTuiFilter(pi: ExtensionAPI): void {
  registerAssistantRenderPatch()
  registerDisplayRenderPatches()

  const streamTextByKey = new Map<string, string>()

  pi.on("session_start", async (_event, ctx) => {
    scrubAssistantMessagesInSessionHistory(ctx.sessionManager)
    streamTextByKey.clear()
  })

  pi.on("message_start", async (event, _ctx) => {
    const role: string = (event.message as any)?.role ?? ""
    if (role === "assistant") {
      streamTextByKey.clear()
    }
  })

  pi.on("message_update", async (event, _ctx) => {
    const msg = event.message
    if (!msg || typeof msg !== "object") return

    const role: string = (msg as any).role ?? ""
    if (role !== "assistant") return

    stripDcpFromAssistantMessageInPlace(msg, true)
    sanitizeAssistantMessageEvent(event, streamTextByKey)
  })

  pi.on("message_end", async (event, _ctx) => {
    streamTextByKey.clear()

    const msg = event.message
    if (!msg || typeof msg !== "object") return

    // Assistant-only: DCP tags only appear in stored assistant messages
    // when the LLM echoes them back from the context
    const role: string = (msg as any).role ?? ""
    if (role !== "assistant") return

    const cleaned = stripDcpFromAssistantMessage(msg)
    if (cleaned !== msg) {
      return { message: cleaned }
    }
  })
}
