---
kind: spec
status: active
---

# Desktop prompt autocomplete

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Give Pix Desktop best-effort LLM prompt autocomplete, including next-message suggestions for an empty composer, without mutating the active conversation. Typed-prefix completion retains the TUI-style behavior; empty-composer prediction is Desktop-specific.

## Scope

- Use the Desktop profile's `autocomplete` configuration from `pix-desktop.jsonc`, including its ordered `fallbackModels`, and configured provider credentials. TUI `pix.jsonc` is not inherited.
- Request completions through a private ACP extension method backed by `ModelRuntime`, not `session/prompt`.
- Debounce eligible drafts, cancel superseded requests, and ignore stale responses.
- Render the returned suffix as muted inline ghost text in the composer.
- Accept the current suffix with Tab and dismiss it with Escape.
- Keep attachment, submission, and native textarea editing behavior intact.

## Non-goals

- Exposing autocomplete settings in the desktop status bar.
- Completing slash commands, shell commands, selections, or drafts whose caret is not at the end.
- Surfacing transient model, authentication, timeout, or transport errors while the user types.
- Changing the default primary autocomplete model or adding empty-composer prediction to the TUI.

## Behavior

- Autocomplete is disabled when `autocomplete.modelRef` is empty.
- A request starts after the configured debounce only for an active session, no attachments, a collapsed selection at the end, and either an exactly empty draft or at least three non-whitespace characters. Drafts starting with `/` or `!`, whitespace-only drafts, and one/two-character drafts are excluded.
- Empty-draft prediction waits until the active prompt is no longer running. It suggests a short next message in the user's voice and language, not an assistant reply. Starting another turn cancels it; completing that turn permits a fresh prediction.
- The ACP request carries the active session id and exact draft. The agent may read recent active-session user/assistant messages according to `includeRecentMessages`, but never sends a normal session prompt.
- For an empty draft, history uses at least the six most recent textual user/assistant messages even when `includeRecentMessages` is zero. Existing per-message, total-context and prompt-token budgets still apply. No model generation starts if history is unavailable, has no user text after trimming, or cannot fit the budget. A model may return no suggestion when the next message is uncertain. Typed drafts continue to honor `includeRecentMessages` unchanged.
- The completion tries `autocomplete.modelRef` and then `autocomplete.fallbackModels` in order, de-duplicating refs. Each candidate uses the configured timeout, output-token limit, prompt budget, and its optional thinking suffix; cancellation is terminal and does not advance the chain.
- Changing the session, draft, selection, attachment state, or eligibility cancels pending work and clears the ghost suffix.
- Late or failed requests cannot replace the current suggestion and do not show an application error.
- Tab appends the visible suffix, keeps focus in the textarea, and does not move focus. Escape clears it. Enter continues to submit normally.
- Accepting an empty-field suggestion fills the draft without sending it. The normal placeholder is hidden while ghost text is visible so the two do not overlap. Escape suppresses another suggestion for the unchanged eligible context.
- Ghost text mirrors the textarea's computed typography, line height, padding,
  wrapping and scrolling rather than relying on parallel CSS defaults. This keeps
  the suffix aligned with the caret across wrapped/multi-line prompts. It is not
  announced as editable content, and a screen-reader status announces that Tab
  can accept it.

## Related behavior

File/folder `@` mentions are a separate feature: see [file mentions](desktop-file-mentions.md).

## Verification

- ACP tests cover request parsing, active-session routing, history access, completion output, and request cancellation.
- Desktop tests cover eligibility, debounce, stale/cancelled requests, dismissal, acceptance, turn-running transitions, and ACP cancellation. ACP tests additionally cover bounded empty-draft history, missing context, budget exhaustion, cancellation during history loading, and the no-suggestion sentinel.
- `desktop/scripts/autocomplete-ghost-smoke.mjs` checks real Chromium computed
  text metrics for the textarea and ghost overlay.
- `npm --prefix acp run check`
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- `npm run check`

## Evidence

- Confirmed by code: TUI autocomplete uses `ModelRuntime.streamSimple`, Pix autocomplete config, suffix cleanup, debounce, timeout, and abort/stale-result protection.
- Confirmed by SDK types: ACP custom request handlers receive an abort signal and `$/cancel_request` aborts it.
- Confirmed by desktop structure: the composer owns caret, selection, keyboard,
  resize, and scroll behavior; the autocomplete/session services provide the
  ACP request and active-session context through the composition root.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"37746817dc3cb78d9acbaf0d53ccce1894fddce3cb6e85cb94315e389c762cd2","checkedAt":"2026-10-31T00:38:12.406Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":64,"reportLanguage":"ru"} -->
