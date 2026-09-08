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
Keep live context high-signal. \`compress\` is the only DCP context tool; use it
only when a closed stale slice materially reduces context pressure. Low context
usage alone does not require compression. Good boundaries include completed
implementation, verification, investigation, config/docs, or understood logs.
Use \`messages\` for one large stale message and batch independent safe work.

Do not compress active work or raw code/errors/output needed next. If unfinished
work is compressed, preserve the active objective and next step. A summary must
preserve user intent/constraints, decisions, relevant files/symbols, actionable
errors, verification state, and next steps. Do not infer, invent, or add facts;
drop duplicate transcript detail, full logs, and long code/JSON/diffs.

\`mNNN\`/\`bN\` IDs and \`<dcp-system-reminder>\` tags are injected metadata;
never quote or output them. Critical/high-pressure reminders take priority;
routine reminders may be skipped when no safe useful slice exists.
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

WHEN: compress only when it materially improves live context or a DCP reminder
identifies useful stale work. Do not compress active/still-needed material. Passing
test/lint/build logs may become command + outcome + actionable failures; discard
raw logs/read/search output after their facts are captured.

SUMMARY: make it COMPLETE FOR CONTINUATION, not a transcript rewrite. Preserve
user intent/constraints, decisions, files/symbols changed or inspected, exact
errors that are still actionable, verification state, unresolved blockers, and
next steps. If work remains unfinished include \`Active objective\` and \`Next
step\`. Do not infer, invent, or add facts. Preserve uncertainty. Do not copy long
raw code, JSON, diffs, logs, or tool output; use short literals only when needed.
Normally omit \`summary\`: DCP generates it. An explicit \`summary\` overrides
generation when parent-authored continuation wording is genuinely required.

MODES:
- \`ranges\`: contiguous \`startId..endId\` spans.
- \`messages\`: one raw \`mNNN\` body when neighbours should remain raw. Use
  \`messages\` for a single large stale message; it does not accept \`bN\`.
Batch independent non-overlapping selections in one call.

BOUNDARIES: use only injected IDs currently visible on stable user/tool-result
carriers. \`mNNN\` is raw, \`bN\` is an active compressed block; IDs may be sparse
and order is the conversation order, not the number. Carrier metadata labels the
carrier plus immediately preceding assistant message(s): \`a\`=assistant,
\`u\`=user, \`t\`=tool result, \`x\`=bash result, \`b\`=block alias. Do not invent IDs. For
\`ranges\`, never split a tool group: include the calling assistant and all its
tool results, including parallel calls. On \`Unknown message ID\`, retry at most
once using the current IDs reported by the tool.

PROTECTION/ROLLUP: preserve \`<protect>...</protect>\` text verbatim. When a
selected range contains compressed blocks, summarize their continuation-relevant
meaning; their protected-fragment ledgers survive separately. Placeholders are
optional: use \`(bN)\` only when the full selected prior summary is genuinely
required verbatim, at most once, and never invent a placeholder. Otherwise refer
to it in prose as \`compressed bN\`.

RESULT: the tool rejects non-positive full-projection gain. An unsuccessful call
does not satisfy a reminder. Inspect \`netGain\`, \`pressureRelieved\`, and
\`remainingRecoveryTokens\`; a positive partial commit can still leave pressure.
Do not discard required facts merely to hit a token target.`

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
