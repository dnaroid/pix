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
You operate in a context-constrained environment. Keep live context high-signal; use \`compress\` only when it materially helps.

\`compress\` is the ONLY context-management tool. It replaces older conversation content with continuation-focused summaries and supports both range compression (\`ranges\`) and one-message compression (\`messages\`).

\`mNNN\`/\`bN\` boundary IDs and \`<dcp-system-reminder>\` tags are environment-injected metadata. Do not output them.

Use compression for context-pressure housekeeping, not after every small step. Low context usage alone does not require compression. Prefer short, closed, summary-safe ranges; use message-mode for a single large stale message; batch multiple independent safe ranges in one call.

Good candidates: completed implementation, verification, config/doc edit, answered exploration, dead-end debugging, or understood test/lint/CI/log inspection. Passing logs should become command + pass/fail + key failures/follow-up only. Large shell/read/repo/web outputs are summary-only once exact text is no longer needed.

Todo completions are useful boundary signals, not automatic triggers. Before compressing while work is unfinished, ensure one \`todo in_progress\` captures the active objective and next step.

Do not compress active work, still-needed raw context, or material whose exact code/error/output will be needed for immediate edits or references.

DCP reminders: handle critical/high-context reminders promptly and compress any safe high-yield closed slice before more exploration; routine reminders mean compress only if a safe, closed, useful slice exists, otherwise continue the next atomic step and re-check later.

Summaries must preserve only what is needed to continue: user intent and constraints, accepted decisions, files/symbols changed or inspected, actionable errors, verification status, and next steps. Drop incidental transcript detail, duplicate outputs, full logs, long code/JSON/diffs, and prose not needed later; include short literals only when required.
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
 *       summary: string        // continuation-focused technical summary
 *     }>
 *   }
 */
export const COMPRESS_RANGE_DESCRIPTION = `Collapse one or more ranges of the conversation into detailed summaries.

CONTEXT-PRESSURE HOUSEKEEPING
Use compression when it will materially improve the live context window. Low context usage by itself does not require compression, even when a small closed slice exists. When context usage is meaningfully high, or a DCP reminder supplies concrete high-yield candidates, closed implementation, verification, config/doc edit, answered exploration, dead-end debugging, or finished test/log inspection can become summary-only before another large exploratory batch.

PASSING LOGS AND LARGE OUTPUTS
Passing check/test/lint/tsc logs are summary-only after you know the result. Preserve command, pass/fail, key failures if any, and follow-up status; drop full passing output. Treat large shell/read/repo/web outputs as disposable evidence once important facts are extracted.

DCP REMINDERS
If a \`<dcp-system-reminder>\` is present in context, treat it as a signal to evaluate compression. Critical or high-context reminders should be handled promptly. Routine reminders should lead to compression only when a safe, closed, useful-to-summarize range exists; otherwise continue the next atomic step and re-check later.

THE SUMMARY
Your summary must be COMPLETE FOR CONTINUATION, not a transcript rewrite. Preserve only information that will plausibly matter later: user intent, accepted constraints, decisions, files/symbols changed or inspected, exact errors that are still actionable, verification status, and next steps.

If active unfinished work exists, start with \`Active objective\` and \`Next step\`.

Default to a compact structured summary (roughly 4-10 bullets for a normal completed work slice). Grow beyond that only when the compressed range contains multiple independent decisions, unresolved blockers, or precise state that is genuinely required to continue.

Do not copy long raw code, JSON, diffs, logs, or tool output into summaries. Prefer semantic descriptions such as “updated foo.json so scene_assets_1.zai-svg has maxConcurrentRuns set to 5.” Include exact snippets only when the literal text is required for safe continuation, and keep them short and single-line.

SUMMARY ARGUMENT SAFETY
The summary is passed as a JSON string argument to the compress tool. Avoid raw double-quoted JSON fragments, multiline object literals, and diff hunks because they can make tool-call arguments malformed. If a literal field name matters, prefer plain prose or quote-light code spans such as \`maxConcurrentRuns: 5\` instead of raw \`"maxConcurrentRuns": 5\` blocks.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote user messages when they are short enough to include safely. Direct quotes are preferred when they best preserve exact meaning.

Be LEAN. Strip away full logs, repeated search/read output, duplicate summaries, incidental failed attempts, and line-by-line edit history. What remains should be pure signal with enough detail to resume work confidently.

TWO COMPRESSION MODES
You may use either or both modes in one call:

- \`ranges\`: collapse contiguous conversation spans using \`startId\`, \`endId\`, and \`summary\`.
- \`messages\`: collapse individual raw messages using \`messageId\`, optional \`topic\`, and \`summary\`.

Use \`messages\` for a single large stale message when surrounding messages should remain raw. \`messages\` accepts only raw \`mNNN\` IDs, not \`bN\` compressed block IDs.

PROTECTED PROMPT CONTENT
If selected user text contains \`<protect>...</protect>\` content, preserve that protected content verbatim in your summary. The tool may append protected text automatically, but you should still account for it semantically.

COMPRESSED BLOCK PLACEHOLDERS
When the selected range includes previously compressed blocks, use this exact placeholder format when referencing one:

- \`(bN)\`

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

Compressed block IDs always use the \`bN\` form (never \`mNNN\`) and are represented as hidden DCP metadata.

Rules:

- Include every required block placeholder exactly once when you intentionally roll up older compressed blocks. If you omit one or duplicate one, the tool will try to recover by preserving the missing block summaries automatically, but do not rely on that recovery path.
- Do not invent placeholders for blocks outside the selected range.
- Treat \`(bN)\` placeholders as RESERVED TOKENS. Do not emit \`(bN)\` text anywhere except intentional placeholders.
- If you need to mention a block in prose, use plain text like \`compressed bN\` (not as a placeholder).
- Preflight check before finalizing: the set of \`(bN)\` placeholders in your summary should match the required set, with no duplicates.

These placeholders are semantic references. They will be replaced with the full stored compressed block content when the tool processes your output.

FLOW PRESERVATION WITH PLACEHOLDERS
When you use compressed block placeholders, write the surrounding summary text so it still reads correctly AFTER placeholder expansion.

- Treat each placeholder as a stand-in for a full conversation segment, not as a short label.
- Ensure transitions before and after each placeholder preserve chronology and causality.
- Do not write text that depends on the placeholder staying literal (for example, "as noted in \`(b2)\`").
- Your final meaning must be coherent once each placeholder is replaced with its full compressed block content.

BOUNDARY IDS
You specify boundaries by ID using the injected metadata IDs present in the conversation context:

- \`mNNN\` IDs identify raw messages (3 digits, zero-padded, e.g. \`m001\`, \`m042\`)
- \`bN\` IDs identify previously compressed blocks

Current raw message IDs are provided in hidden DCP control metadata at the end of the model context.
Some message-compression candidate hints include a low/medium/high priority; prefer high-priority stale message IDs for message-mode compression when a full range would be too broad.
The ID reference line appears at the end of the message it belongs to — it identifies the message above it, not the one below it.
Treat these reference lines as boundary metadata only, not as tool result content.

Rules:

- Pick \`startId\` and \`endId\` directly from injected IDs in context.
- IDs must exist in the current conversation context.
- \`startId\` must appear before \`endId\`.
- Do not invent IDs. Use only IDs that are present in context.
- If \`compress\` fails with \`Unknown message ID\`, treat those IDs as stale; retry at most once using only the error's listed current raw IDs or eligible \`bN\` blocks, or skip if no closed range is safe.

BATCHING
When multiple independent ranges or individual messages are ready, include all of them in one \`compress\` call. Range entries must not overlap. Message entries should each summarize exactly one raw message.`

/**
 * Injected into messages when context usage exceeds maxContextPercent.
 * nudgeForce = "strong" — emergency recovery tone.
 */
export const CONTEXT_LIMIT_NUDGE_STRONG = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST use the \`compress\` tool now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.
If any closed slice exists (finished implementation, verification, config/doc edit, answered exploration, dead end, or test/log inspection), compress it before replying or starting another task. Passing logs should become command + pass/fail + follow-up status only.
Recently completed todo/task/subtask items are preferred boundaries when they form a high-yield closed slice.

RANGE STRATEGY (MANDATORY)
Prioritize one large, closed, high-yield compression range first.
This overrides the normal preference for many small compressions.
Only split into multiple compressions if one large range would reduce summary quality or make boundary selection unsafe.

RANGE SELECTION
Start from older, resolved history and capture as much stale context as safely possible in one pass.
Avoid the newest active working slice unless it is clearly closed.
Use injected boundary IDs for compression (\`mNNN\` for messages, \`bN\` for compressed blocks), and ensure \`startId\` appears before \`endId\`.
For a single large stale message, use the \`messages\` array with its injected \`mNNN\` ID.

SUMMARY REQUIREMENTS
Your summary must cover all essential details from the selected range so work can continue without reopening raw messages, but it should not restate raw code, JSON, logs, or diffs unless a short literal is required.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</dcp-system-reminder>`

/**
 * Injected into messages when context usage exceeds maxContextPercent.
 * nudgeForce = "soft" — high context-pressure tone.
 */
export const CONTEXT_LIMIT_NUDGE_SOFT = `<dcp-system-reminder>
ACTION REQUIRED: Context usage is high.

Before doing more exploration, look for a high-yield closed range that no longer needs to stay raw. Compress it now if one is safe and useful.

This is context-pressure guidance, not a request to compress tiny or still-needed slices. If completed research, implementation, verification, config/doc edit, CI-log inspection, or dead-end debugging is large enough to reduce signal, call the \`compress\` tool before continuing normal work.
Recently completed todo/task/subtask items are preferred candidates when they form a non-trivial closed slice; do not compress merely because a tiny todo was completed.
High-priority stale shell/read/repo/web outputs should be compressed once no exact raw text is needed. Passing logs should not remain raw after they are understood.

RANGE SELECTION
Prefer older, resolved history. Avoid the newest active working slice unless it is clearly done.
Use injected boundary IDs (\`mNNN\` for messages, \`bN\` for compressed blocks) and ensure \`startId\` appears before \`endId\`.
For a single large stale message, use message-mode compression via the \`messages\` array.

If multiple independent high-yield ranges are ready, batch them in a single \`compress\` call.
If nothing is cleanly closed and worth summarizing yet, continue with the next atomic step and re-check later.
</dcp-system-reminder>`

/**
 * Injected as a lightweight reminder between minContextPercent and maxContextPercent
 * at the configured nudgeFrequency cadence.
 */
export const TURN_NUDGE = `<dcp-system-reminder>
CONTEXT CHECK: Evaluate whether compression would materially improve the live context.

If a range is cleanly closed, non-trivial, and unlikely to be needed verbatim again, use the \`compress\` tool. If direction has shifted, consider whether earlier ranges are now less relevant.

If a todo/task/subtask was just completed, treat that completed work as a preferred compression boundary when it is large enough and no longer needed raw; completion alone is not a reason to compress while context is still low.

Do not compress just because a small slice closed while context is still low. Prefer compression before another large batch of searches, reads, CI log fetches, or tests when a high-yield stale slice exists.
High-priority stale shell/read/repo/web outputs and understood passing logs should be compressed once no exact raw text is needed.

Prefer small, closed-range compressions over one broad compression.
Use message-mode compression for isolated large stale messages.
The goal is to filter meaningful noise and distill key information so context accumulation stays under control.
Keep active context uncompressed.
</dcp-system-reminder>`

/**
 * Injected after iterationNudgeThreshold tool calls since the last user message.
 */
export const ITERATION_NUDGE = `<dcp-system-reminder>
CONTEXT CHECK: You've been iterating for a while after the last user message.

Pause before the next large non-atomic tool batch. If there is a closed portion that is unlikely to be referenced immediately and is worth summarizing (for example, finished research before implementation, completed config edit, completed CI-log triage, a verified fix, or a dead-end investigation), use the \`compress\` tool on it.

If a todo/task/subtask was just completed, prefer that completed work as the compression boundary when it is non-trivial and safe to summarize; do not compress merely because the todo status changed.

Avoid accumulating large tool outputs while a high-yield completed slice remains raw. If only small or still-needed ranges are closed, continue the next atomic step and re-check later.

Prefer multiple short, closed ranges over one large range when several independent slices are ready.
Use message-mode compression for isolated large stale messages.
</dcp-system-reminder>`

/**
 * Replaces SYSTEM_PROMPT when manualMode.enabled = true.
 * The agent should NOT proactively compress — only compress when explicitly
 * requested by the user or when a context-limit nudge fires.
 */
export const MANUAL_MODE_SYSTEM_PROMPT = `
You are operating in DCP manual mode for context management.

\`mNNN\`/\`bN\` DCP boundary IDs and \`<dcp-system-reminder>\` tags are environment-injected metadata. Do not output them.

In manual mode you do NOT proactively compress conversation content. Compression is a deliberate, user-directed action.

WHEN TO COMPRESS
- Only when the user explicitly asks you to compress
- Only when a \`<dcp-system-reminder>\` nudge instructs you to (context-limit emergency)
- Never as background housekeeping or on your own initiative

WHEN YOU DO COMPRESS
Apply the same quality standards as always:

- Summaries must be complete for continuation, not transcript-sized; keep only file paths, decisions, findings, exact constraints, unresolved blockers, and verification state that may matter later
- Avoid raw JSON/code/diff/log blocks in summary strings; describe changes in prose or use very short quote-light code spans when literals are necessary
- Preserve user intent precisely; prefer direct quotes for short user messages
- Use only boundary IDs present in context (\`mNNN\` for messages, \`bN\` for compressed blocks)
- Batch independent ranges in a single \`compress\` call when possible
- Use message-mode compression for isolated large stale messages when directed by a context-limit nudge

Do not compress active, still-needed context. Only compress ranges that are genuinely closed and whose raw form is no longer required.
`.trim()
