# Claude Code “You Should Know” — clean-room reconstruction

Source analyzed: `@anthropic-ai/claude-code-darwin-arm64@2.1.288`.

The built-in plugin is embedded in the native Claude Code executable as Bun chunk
`/$bunfs/root/chunk-3wpxt1pf.js`. The notes below are a behavioral reconstruction,
not a copy of Anthropic’s minified source.

## 1. Plugin surface

The embedded module declares hooks for:

- `prompt.submit`
- `command.run`
- `turn.step`
- `ui.render`
- `session.detach`
- `session.end`

It calls engine capabilities corresponding to:

- clock/timers
- environment reads
- `model.fork`
- prompt read/fill/submit
- session id/surfaces/version
- plugin state/store
- telemetry
- UI resolve/invalidate/toast

The plugin is built-in and default-disabled.

## 2. Core cadence

Key constants recovered from the module:

```text
CHECK_EVERY = 6
CLEAR_AFTER_PROMPTS = 2
SEEN_MAX = 50
SESSIONS_MAX = 32
CHECKS_KEPT = 3
ASKED_MS = 20_000
SHOWN_KEEP_MS = 259_200_000   # about 3 days
MAX_CARDS = 4
MAX_LINE_WIDTH = 240
```

The proposal path can be represented approximately as:

```ts
on("turn.step", async function* (ctx, step, next) {
  // Critical: child/subagent steps are not observed directly.
  if (step.agentId !== undefined) {
    yield* next(step)
    return
  }

  updatePrompt/session bookkeeping()

  if (step.index === 0) {
    ageOrClearVisibleOffers()
    yield* next(step)
    return
  }

  if (step.index % CHECK_EVERY !== 0) {
    yield* next(step)
    return
  }

  if (alreadyOfferedThisTurn()) return
  if (thereIsAnOpenCard()) return
  if (!currentSurfaceCanShowTheBand()) return
  if (proposalAlreadyInFlight()) return

  if (adaptiveSkipCounter > 0) {
    decrementSkipCounter()
    return
  }

  rememberAskedTurn(step.turnId)

  const result = await ctx.model.fork({
    prompt: buildProposalPrompt(seenTopics, knownTopics),
  })

  const parsed = parseProposal(result)

  if (parsed.none) record("none")
  else if (parsed.invalid) record("parse_failed")
  else if (duplicate(parsed.line, seenTopics, knownTopics)) record("deduped")
  else if (askedTurnIsNoLongerCurrent()) record("stale")
  else {
    rememberSeen(parsed.line)
    showOffer(parsed)
    record("shown")
  }

  yield* next(step)
})
```

### Important subagent finding

The module explicitly checks whether `turn.step` has an `agentId` and bypasses
the observer when it does.

So the original Claude Code implementation also **does not watch subagent turns
directly**.

It can still learn about delegated work indirectly if that information becomes
part of the parent conversation context seen by `model.fork`, for example when
the parent receives or reads a child result.

There is no dedicated subagent-completion hook in this mod.

## 3. Adaptive annoyance control

Besides the fixed every-six-steps gate, the mod tracks when offers survive past
user prompts without engagement.

Repeatedly ignored suggestions increase an adaptive skip counter. The recovered
shape is approximately:

```ts
function skipAfterIgnoredCount(ignored: number) {
  if (ignored <= 2) return 0
  return Math.min(16, 2 ** (ignored - 3))
}
```

So after the user repeatedly types past suggestions, checks are increasingly
spaced out instead of continuing every sixth step.

This is one of the more useful differences from a simple periodic observer.

## 4. Proposal model call

The module does not run a normal tool-using agent. It calls `model.fork`.

The side request is framed as:

- a separate lightweight one-off agent;
- the main agent continues independently;
- it shares conversation context;
- it has no tools;
- it can only use information already present in the conversation;
- it must not expose secrets/credentials/private data.

The mod does not hard-code a public model identifier in this chunk. Model
selection is delegated to Claude Code’s `model.fork` implementation.

## 5. Proposal policy

The proposal prompt strongly biases toward silence.

Behaviorally, it asks the fork to:

- default to no suggestion;
- interrupt only for something consequential;
- prefer topics whose misunderstanding could have meaningful negative
  consequences;
- avoid things the user is already discussing or clearly understands;
- avoid repeating prior suggestions and things marked as already known;
- allow an important detail buried in a long working session to qualify;
- distinguish a conceptual/system fact (“You should know”) from an immediate
  session decision/tradeoff (“Heads up”).

The parser accepts essentially:

```text
learn: none
```

or a short learn line, a tag (`You should know` / `Heads up`) and an optional
explanation payload.

The visible one-line offer is bounded to about 240 characters.

## 6. State

The module keeps both persistent store state and in-memory coordination state.

Persistent concepts include:

```ts
sessions[] = {
  id,
  offeredTurn?,
  askedTurn?,
  checked?,
  checks?,
  tag?,
  view?
}

seen[]       // recently shown proposal lines, max 50
known[]      // topics user said they already know, max 50
typedPastInARow
looksToSkip
```

A session view is one of roughly:

```ts
undefined
offer
explaining
explained
asked
making
ready
failed
off
```

Session records are bounded. Recently shown UI entries receive eviction
protection for roughly three days.

## 7. Deduplication and stale-result protection

Before a proposed line is shown:

1. It is normalized.
2. It is compared with both `seen` and `known`.
3. The mod checks that the session’s recorded `askedTurn` still matches the
   turn that initiated the fork.
4. A session that has ended/detached or otherwise changed ownership cannot
   publish the old result as a current offer.

The dedupe mechanism is text/topic based rather than evidence-ID based.

## 8. UI flow

Initial offer:

```text
Heads up / You should know · <short line>

1  Learn more
2  Knew this already
0  Dismiss
```

A disable action is available on some surfaces.

If the user requests an explanation, a second `model.fork` produces a compact
plain-language explanation. The expanded state offers:

```text
1  Understood
2  Chat in main session
0  Dismiss
```

The explanation can be regenerated in variants corresponding to:

```text
simpler_words
less_detail
more_detail
```

There is also a learning-page/artifact flow with feedback actions. That part is
separate from the core observer.

“Chat in main session” first tries to fill the composer. If there is no composer
surface available, the mod can submit the prepared text through the main prompt
interface. This is more interventionist than Pix’s current “insert draft only”
rule.

## 9. Explanation formatting

The parser supports a bounded explanation made of up to four cards/sections.

Recovered formatting limits include approximately:

```text
max cards             4
title width           120 characters
sketch lines          12
sketch line width     120
lead/caption length   4000
```

The explanation prompt is intentionally one-topic and context-switch friendly,
with separate first/simpler/less-detail/more-detail length targets.

## 10. Telemetry

The mod records events including:

```text
you_should_know_proposed
you_should_know_answered
you_should_know_explained
learn_page
```

Proposal outcomes include:

```text
shown
none
parse_failed
deduped
stale
aborted
api_error
error
```

It records latency and fork usage (cache read/create and output tokens), plus UI
outcomes such as already-known, dismissed, ignored, helpful/not relevant, etc.

This telemetry appears designed to measure precision, annoyance, latency and
cost—not just whether the side model can generate a suggestion.

## 11. Availability

The plugin is default-disabled and gated by Claude Code eligibility checks.
The public release note describes it as available for first-party sessions with
telemetry enabled. The embedded availability logic also excludes certain privacy
modes.

## 12. Comparison with Pix Heads Up

### Claude Code has

- implicit full parent-conversation context through `model.fork`;
- a fixed six-parent-step cadence;
- adaptive backoff after repeated ignored offers;
- persistent `seen` / `known` topic history;
- explanation regeneration;
- optional learning-page generation;
- extensive first-party telemetry.

### Pix currently has

- an explicit bounded context package;
- evidence IDs and strict validation of cited evidence;
- explicit input/hourly budgets;
- explicit model selection with no hidden fallback;
- durable usage accounting in the originating session;
- stricter lifecycle/cancellation accounting;
- Desktop statusbar controls/settings;
- a reproducible synthetic/live eval harness;
- draft-only handoff back to the parent.

### Both share the same important limitation

Neither implementation directly observes child/subagent internal turns.

Claude Code’s mod explicitly bypasses `turn.step` when `agentId` is present.
Pix currently disables Heads Up inside suite subagent runtimes and observes the
parent projection.

Therefore the proposed Pix improvement—feeding bounded, provenance-preserving
delegated-work evidence to the single parent observer—would actually go beyond
the behavior recovered from Claude Code 2.1.288 rather than merely copying it.

## 13. Most useful ideas to borrow

The strongest ideas worth considering for Pix are:

1. **Adaptive annoyance backoff.**
   Fixed cadence is not enough; repeated non-engagement should reduce future
   interruptions.

2. **Persistent distinction between seen and known.**
   “I saw this” and “I already understand this” are different signals.

3. **Strict default-to-none prompt.**
   Precision should dominate recall for an interruptive surface.

4. **Track proposal quality separately from user interaction.**
   `none`, `deduped`, `stale`, parsing failures, latency and usage should not be
   collapsed into one success metric.

5. **Keep the proposal fork one-shot and tool-less.**
   The observer should observe, not become another executor.

The child-agent blind spot is *not* something to copy.
