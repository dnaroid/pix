# First-prompt model routing

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Pix can optionally expose an `Auto` model choice for a new, still-sessionless draft. `Auto` classifies the first real user prompt into a semantic task tier, then creates the actual session directly on that tier's configured model and thinking level. The routing call is stateless and never becomes part of conversation history.

## Configuration contract

- TUI reads `modelRouting` from `pix.jsonc`; Desktop reads the same shape from `pix-desktop.jsonc`. The profiles remain independent.
- Routing is disabled by default. `enabled: true` only makes `Auto` available in the new-draft model picker; it does not replace the configured default model automatically.
- `default: true` makes new UI-only conversation drafts start in `Auto`. It defaults to false and is dormant while routing is disabled. An explicit CLI/runtime model override still wins.
- `modelRef` is the primary router model. The default is `openrouter/~typesafe/jev-latest`.
- `fallbackModels` is the ordered router-model fallback chain and defaults to `[]`.
- `defaultTier` is the deterministic semantic tier selected when every router model is unavailable, fails, times out, or returns an invalid decision.
- `tiers` is an ordered array. Each entry has semantic `id`, router-facing `description`, target `modelRef`, and target `thinking`.
- Tier ids match `^[a-z][a-z0-9_-]*$`. Duplicate configured ids collapse to the last configured entry.
- Built-in tiers are:
  - `simple` → `openrouter/~openai/gpt-luna-latest` · `minimal`;
  - `standard` → `openrouter/~openai/gpt-terra-latest` · `medium`;
  - `complex` → `openrouter/~openai/gpt-sol-latest` · `high`;
  - `expert` → `openrouter/~openai/gpt-astra-latest` · `xhigh`.
- Router prompts expose only tier ids/descriptions, never target model refs, so tier semantics remain stable when users replace concrete models.

## Routing contract

1. Routing is eligible only on a UI-only new-session draft whose selected model mode is `Auto`.
2. The first normal user prompt is classified before a real Pi/ACP session is created. Image-only first prompts remain routable through attachment count even when prompt text is empty.
3. Shell commands, renderer slash commands, resume/load flows, and existing sessions never trigger first-prompt routing.
4. OpenRouter Jev routers use OpenRouter's Decisions API (`POST /api/alpha/decisions`) with one `choice` question whose criteria are the configured tier ids/descriptions. Generic fallback router models use the shared ModelRuntime with a structured `select_task_tier` tool and also accept minimal JSON/bare-id output.
5. Router models are tried in primary-then-fallback order, de-duplicated.
6. Router work uses no cache retention, no provider retries, and a 10-second timeout. Cancellation or draft/session ownership changes invalidate the result.
7. A valid tier resolves to its `modelRef` + `thinking`; the real session is created once with that selection and the original user prompt becomes its first user message.
8. If routing produces no valid tier, Pix uses `defaultTier` instead of failing the first prompt.
9. Manual model selection exits `Auto`. An explicit CLI/runtime model override keeps routing unavailable for that draft.

## UI contract

- While `modelRouting.enabled` is true, `Auto` appears in both new-draft and live/existing-session model pickers and is pinned to the first row even when another model is current or a fuzzy query is active.
- Selecting `Auto` from a live/existing session never re-routes or mutates that session. It opens or reuses the UI-only New Conversation draft and stages `Auto` there, so routing still applies only to the first prompt of the new conversation.
- Before Auto has selected a tier, status bars show only `Auto`; they do not display a placeholder/fake thinking level.
- TUI explains that Auto thinking is chosen by the selected tier rather than presenting a fake fixed thinking level. The combined picker exposes a clickable `Set default` action and `Ctrl+D`; concrete selections persist the staged model + thinking, while Auto persists `modelRouting.default: true`.
- Desktop disables manual thinking while Auto is staged and explains that model + thinking are chosen from the first prompt. Its combined picker exposes `Set default` / `Default ✓` for either the staged concrete model+thinking pair or Auto.
- Desktop Settings exposes routing enablement, the `Auto by default` toggle, router model, router fallbacks, deterministic fallback tier, and editable tier id/description/model/thinking rows.

## Lifecycle and ownership

- Routing stays sessionless. Temporary model runtimes keep extension-registered providers alive only while routing is active, then invalidate their temporary extension runtime.
- Desktop draft materialization owns an abort controller; closing/replacing/resetting the draft cancels routing before a late result can create a session.
- TUI aborts superseded routing requests and discards completions after input-tab ownership or draft-mode changes.
- Resumed or already-materialized sessions are never re-routed.

## Related files

- `src/config.ts`
- `src/default-pix-config.ts`
- `src/app/model/model-routing.ts`
- `src/app/input/input-action-controller.ts`
- `src/app/session/tabs-controller.ts`
- `src/app/runtime.ts`
- `src/app/app.ts`
- `src/app/popup/menu-items-controller.ts`
- `src/app/popup/popup-action-controller.ts`
- `src/app/popup/popup-menu-controller.ts`
- `src/app/rendering/popup-menu-renderer.ts`
- `acp/src/acp/model-routing.ts`
- `acp/src/acp/draft-model-runtime.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src/app/model-draft-config.svelte.ts`
- `desktop/src/app/draft-session.svelte.ts`
- `desktop/src/app/prompt-submit.ts`
- `desktop/src/components/ModelThinkingPicker.svelte`
- `desktop/src/components/settings/DesktopSettingsEditor.svelte`
- `desktop/src/components/settings/SettingsModelRoutingTiers.svelte`
- `desktop/src/components/settings/SettingsSelect.svelte`
- `desktop/src/lib/acp-pix-extensions.ts`
- `desktop/src/lib/model-thinking.ts`
- `src/schemas/pix-schema.ts`
- `src/schemas/pix-desktop-schema.ts`

## Verification

- Config tests cover disabled defaults, Jev router defaults, semantic tiers, tier thinking, and profile merging.
- Router tests cover decision parsing, fallback chains, semantic prompt content, target-model hiding, and deterministic fallback.
- TUI input tests verify routing occurs before materialization and passes the routed model into first-session creation.
- Desktop tests verify the private ACP routing request, draft-only Auto option, first-prompt routing, cancellation guards, and model-picker presentation.
- Root, ACP, Desktop, and generated-schema checks must pass.
