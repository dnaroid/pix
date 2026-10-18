// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — PI extension prompts
// ---------------------------------------------------------------------------
// All prompt text is exported as plain strings so the extension index can
// reference them by name without executing any logic here.
// ---------------------------------------------------------------------------

/**
 * Appended to the existing system prompt when DCP is enabled (automatic mode).
 */
export const SYSTEM_PROMPT = `
Keep context focused. \`compress\` is the only DCP context tool; use it only
for closed stale work that frees context. Low context
usage alone does not require compression. Closed work includes completed
implementation, verification, investigation, config/docs and understood logs.
Use \`messages\` for one large stale message.

Batch newly closed stages early when substantial work remains, not each small
result. Keep prior summaries unchanged unless correction or context-limit
recovery requires rewriting them.

Compression can invalidate prompt caches; fewer tokens need not mean lower cost.
Skip optional near-finish housekeeping with ample headroom.
Context-limit recovery and explicit user requests take priority.

Do not compress active work or needed raw code/errors/output. For unfinished
work preserve the active objective and next step. Summaries retain user
requirements, decisions, files/symbols, actionable errors, verification and
next steps. Do not infer, invent, or add facts; drop duplicate transcript detail,
logs and long code/JSON/diffs.

\`mNNN\`/\`bN\` IDs and \`<dcp-system-reminder>\` are metadata; never output them.
Prioritize critical reminders; skip routine ones without a safe useful slice.
`.trim()

/**
 * Appended to the DCP system prompt: tells the agent whether an omitted
 * \`summary\` is written by a configured summarizer model or falls back to the
 * deterministic extractive record (which is far weaker than an agent summary).
 */
export const SUMMARY_AUTHORING_SELF = `
No DCP summarizer model is configured: always write the \`compress\` \`summary\`
yourself. An omitted summary becomes a coarse extractive record.
`.trim()

export const SUMMARY_AUTHORING_DELEGATED = `
A DCP summarizer model is configured: you may omit the \`compress\` \`summary\`
unless parent-authored continuation wording is genuinely required.
`.trim()

/**
 * Used as the \`description\` field when registering the \`compress\` tool.
 *
 * Tool signature:
 *   {
 *     topic:  string           // 3-5 word label for this compression
 *     ranges: Array<{
 *       startId: string        // mNNN or bN
 *       endId:   string        // mNNN or bN
 *       summary?: string       // optional parent-authored summary
 *     }>
 *   }
 */
export const COMPRESS_RANGE_DESCRIPTION = `Replace closed stale context with continuation-focused summaries.

WHEN: compress closed stale work only if it improves context or a DCP reminder
identifies useful work. Never compress needed material. Passing checks may become
command + outcome + actionable failures; discard raw logs/reads/search output.

SUMMARY: COMPLETE FOR CONTINUATION, not a transcript. Preserve requirements,
decisions, changed/inspected files/symbols, exact
errors that are still actionable, verification, blockers and next steps.
For unfinished work include \`Active objective\` and \`Next step\`.
Do not infer, invent, or add facts; preserve
uncertainty. Do not copy long raw code, JSON, diffs, logs or tool output.
Drop incidental log lines without quoting their markers or narrating their removal. Write \`summary\` yourself
unless a summarizer is configured; omitting it yields a coarse extractive record.

MODES:
- \`ranges\`: contiguous \`startId..endId\` spans.
- \`messages\`: one raw \`mNNN\` body when neighbours should remain raw. Use
  \`messages\` for a single large stale message; it does not accept \`bN\`.
Batch independent non-overlapping selections in one call.

BOUNDARIES: use only IDs visible on stable user/tool-result carriers.
\`mNNN\`=raw, \`bN\`=active block; IDs may be sparse and follow conversation order,
not numerical order. Carrier labels include preceding assistants: \`a\` assistant,
\`u\` user, \`t\` tool result, \`x\` bash, \`b\` block alias, \`~Nk\` approximate size.
Do not invent IDs. For
\`ranges\`, never split a tool group: include the calling assistant and all its
tool results, including parallel calls. On \`Unknown message ID\`, retry once
with current IDs reported by the tool.

PROTECTION/ROLLUP: preserve \`<protect>...</protect>\` verbatim. For selected
compressed blocks, summarize their continuation-relevant meaning; protected
ledgers survive. Historical action receipts may be hash-bound session
references. Read entry_id="dcp:bN" and nextCursor before reusing covered
actions; UNKNOWN outcomes forbid blind retry. Pins stay inline. Placeholders are
optional: use \`(bN)\` at most once if the full prior summary is needed verbatim;
never invent placeholders. Otherwise refer to \`compressed bN\`.

Retain facts: paths/outcomes/open work; external effects with operation IDs and
UNKNOWN outcomes (never blindly retry); tests with command, observed outcome,
actionable error, log pointer, code revision or UNKNOWN. Historical tests are
not current verification. Consolidate completed phases and current todo/subagent
state with recovery links. Reads, searches and old compress reports need not be
verbatim.

RESULT: rejects non-positive full-projection gain. An unsuccessful call
does not satisfy a reminder. Inspect \`netGain\`, \`pressureRelieved\` and
\`remainingRecoveryTokens\`; a positive partial commit can still leave pressure.
Preserve required facts regardless of token target.`

/**
 * Injected into messages when context usage exceeds maxContextPercent.
 * nudgeForce = "strong" — emergency recovery tone.
 */
export const CONTEXT_LIMIT_NUDGE_STRONG = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED
You MUST use the \`compress\` tool now, after any critical atomic step. Prefer one
large, older, closed high-yield range; split only for safety/summary quality. Keep
the newest active slice raw. Preserve user intent exactly and all state needed to
continue, but not full logs/code/diffs. Use current injected IDs; use \`messages\`
for one isolated large stale message.
</dcp-system-reminder>`

/**
 * Injected into messages when context usage exceeds maxContextPercent.
 * nudgeForce = "soft" — high context-pressure tone.
 */
export const CONTEXT_LIMIT_NUDGE_SOFT = `<dcp-system-reminder>
ACTION REQUIRED: Context usage is high.
Before more exploration, compress a high-yield older closed slice if one is safe
and useful. Keep active/tiny slices raw; understood logs/search/read output are
good candidates. Batch independent ranges; use message-mode compression for one
large stale message. If nothing is cleanly closed, continue with the next atomic
step and re-check later.
</dcp-system-reminder>`

/**
 * Injected as a lightweight reminder between minContextPercent and maxContextPercent
 * at the configured nudgeFrequency cadence.
 */
export const TURN_NUDGE = `<dcp-system-reminder>
CONTEXT CHECK: Evaluate whether compression would materially improve the live context.
Compress only a non-trivial closed stale slice that no longer needs verbatim text,
especially before another large tool batch. Do not compress just because a small
slice closed. Prefer closed ranges; use message-mode compression for an isolated
large stale message. Keep active context uncompressed.
</dcp-system-reminder>`

/**
 * Injected after iterationNudgeThreshold tool calls since the last user message.
 */
export const ITERATION_NUDGE = `<dcp-system-reminder>
CONTEXT CHECK: You've been iterating for a while after the last user message.
Before another large tool batch, compress completed non-trivial work that no longer
needs raw detail. Prefer closed ranges; use message-mode compression for an
isolated large stale message. If only small or still-needed ranges are closed,
continue the next atomic step and re-check later.
</dcp-system-reminder>`

/**
 * Replaces SYSTEM_PROMPT when manualMode.enabled = true.
 * The agent should NOT proactively compress — only compress when explicitly
 * requested by the user or when a context-limit nudge fires.
 */
export const MANUAL_MODE_SYSTEM_PROMPT = `
You are operating in DCP manual mode for context management.
Do NOT proactively compress. Use \`compress\` only when the user explicitly asks
or a \`<dcp-system-reminder>\` requires context-limit recovery. Preserve user
intent precisely and enough decisions/files/errors/verification/next state to
continue; omit long raw code/JSON/diffs/logs. Use only visible \`mNNN\`/\`bN\`
IDs, batch independent safe ranges, and use message-mode for one large stale
message. Do not compress active, still-needed context. Injected DCP IDs/reminder
tags are metadata; never output them.
`.trim()
