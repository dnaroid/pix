---
kind: spec
status: active
---

# Codex reasoning replay wire workaround

## Scope and motivation

Installed `@earendil-works/pi-ai` 0.87.1 can replay a persisted assistant
`thinkingSignature` containing a Responses reasoning item with `content: null`
or `content: []`. Its converter parses the signature as JSON and passes the
reasoning item into request input without removing that field. This extension
normalizes only those two legacy shapes at the suite's outgoing
`before_provider_request` boundary. It is a **wire-only workaround**: it does
not rewrite signatures, session JSONL, assistant messages, or the SDK converter.
The issue is not restricted to old sessions: the installed response-stream
processor serializes the complete reasoning item into `thinkingSignature`, so
new output containing either field shape can also be replayed unchanged.

The two cases have different evidence. [First-party Codex serialization](https://github.com/openai/codex/blob/7dae8c53/codex-rs/protocol/src/models.rs)
omits *empty arrays*, but serializes *absent content as null*. The optional
Responses `content` schema field does not admit null; [issue #47733](https://github.com/openai/codex/issues/47733)
reports a **third-party** strict Responses provider rejecting that null. These
sources motivate matching the first-party empty-array wire shape and omitting
schema-invalid null respectively. Neither the issue nor our tests verify a
current ChatGPT Codex endpoint 400 for either shape. There was no backend A/B.

## Exact contract

`stripReasoningContentFromPayload(payload, model)` is active only when the
selected context model's `api` is exactly `openai-responses` or
`openai-codex-responses`, `payload` is an object (not an array), and
`payload.input` is an array. Model provider, id, and any `payload.model` are
not gates. For an object entry of that input whose `type` is exactly
`reasoning`, remove its **own** `content` property iff its value is exactly
`null` or an empty array. Preserve all other properties, including `id`,
`encrypted_content`, and `summary`.

| Input / context | Result |
| --- | --- |
| Either exact API, reasoning item with own `content: null` or `content: []` | Omit that property only |
| Reasoning with nonempty content (including a nonempty array), malformed content (`string`, object, number, `undefined`), or absent/inherited content | Preserve item |
| `function_call_output`, `message`, unknown type, user entry, or non-object input entry | Preserve item even if content is null/empty |
| `messages`, other payload fields, other APIs, missing/non-array `input`, or invalid model/payload | Preserve unchanged |

On a change, copy the payload, its input array, and only affected entries;
never mutate the original input, items, or nested values. Unaffected entries
retain their references. On a no-op return the *original payload reference*;
the registered hook returns `undefined` in that case, rather than a redundant
replacement. The hook registers last in `src/index.ts::MODULES` **within this
suite**; a different extension can run later, so this is not a global
last-writer or final-payload guarantee. Do not patch `node_modules`.

The previous predicate removed own `content` from every explicitly typed
non-message item and accepted either `input` or `messages`. That was broader
than the demonstrated producer and could erase meaningful content on future
or unknown item types. The installed SDK emits tool results with `output`,
not `function_call_output.content`; no real producer/repro justified keeping
a guard for that field. A hypothetical third-party hook is not enough reason
for blanket sanitization, particularly without a global hook-order guarantee.

This change deliberately **removed the existing cache-field stripping
workaround**. It never deletes or rewrites `prompt_cache_retention` (nor other
unrelated fields). In the pinned 0.87.1 SDK, the OpenAI Responses builder uses
`prompt_cache_options` for models whose compat declares
`supportsExplicitPromptCacheMode`; with long retention it emits `ttl: "30m"`.
The pinned OpenAI catalog declares that flag on `gpt-5.6-luna`, `gpt-5.6-sol`,
and `gpt-5.6-terra`. The Codex request builder does not emit legacy retention.
The direct OpenAI builder
still emits legacy `prompt_cache_retention: "24h"` for long retention when
`supportsLongCacheRetention` is true and explicit cache mode is false, including
custom OpenAI-compatible models with that configuration. Owners of those
custom compat declarations, not this reasoning sanitizer, must determine
whether their endpoint accepts the legacy field. The offline real-builder
test proves retention in that configuration, **not** acceptance by a backend.
This evidence and catalog statement are scoped to installed pi-ai 0.87.1;
recheck after SDK upgrades.

## Replay and cached WebSocket boundary

The installed converter's `convertResponsesMessages` parses
`thinkingSignature` JSON and pushes the item as-is when replaying the same
provider/API/model identity. The real-converter test confirms both legacy
values survive that path, while switching the selected model id, provider, or
API drops the empty thinking in its tested fixture. The sanitizer keys off the
*selected API*, not provider name: a proxy provider on the same API is still
eligible. This is a bounded fixture result, not a claim that every other
signature or identity switch behaves the same.

On the installed cached Codex WebSocket path, the full request body is passed
through the hook before sending. The SDK keeps that sanitized body as
`lastRequestBody` but independently converts the prior assistant response into
unsanitized `lastResponseItems`. `getCachedWebSocketInputDelta` first compares
body-minus-input, then compares JSON stringification of the current input
prefix with `lastRequestBody.input + lastResponseItems`. For a replayed null or
empty-array reasoning item, the sanitized current prefix lacks `content` but
the response-item baseline retains it. Prefix equality fails, the SDK clears
continuation, and the full sanitized context is sent instead of a delta. The
test mirrors this exact prefix comparison and checks both failing sanitized
and succeeding unnormalized prefixes; it is **not a real WebSocket integration
test**, does not restore delta continuation, and proves no endpoint outcome.
SSE and WebSocket use the sanitized request subject to later hooks, while the
SDK's separate continuation baseline remains outside this hook's reach.

## Durable fix and removal criteria

Normalize replayed reasoning content in upstream pi-ai's converter/replay
boundary, before both outgoing `input` and cached WebSocket `lastResponseItems`
are formed. Remove this extension only after the pinned SDK used here adopts
that behavior and positive tests confirm null/empty-array replay yields valid
wire input **and** a matching continuation baseline for cached WebSocket
requests. Retain negative tests showing nonempty/malformed content, other
item types (`function_call_output` included), unrelated APIs and `messages`
remain untouched; retain identity-switch and cache-compat coverage. Verify
both paths on the updated SDK rather than treating a wire-only hook or a
successful single request as proof that continuation was repaired. No session
persistence migration is implied by this removal criterion.

## Ownership and verification (observed 2026-09-25)

### Installed SDK evidence locations

Under `node_modules/@earendil-works/pi-ai/dist/` (inspection only; never patch):

- `api/openai-responses-shared.js`: `processResponsesStream` records signatures;
  `convertResponsesMessages` parses and replays them.
- `api/transform-messages.js`: same-identity signature preservation versus
  cross-identity thinking conversion/drop.
- `api/openai-responses.js`: compat defaults and cache request-field builders.
- `api/openai-codex-responses.js`: hook/transport boundary,
  `getCachedWebSocketInputDelta`, `buildCachedWebSocketRequestBody`, and the
  independently converted `lastResponseItems` in `processWebSocketStream`.

## Implementation

- `external/pi-tools-suite/src/codex-reasoning-fix/index.ts`
- `external/pi-tools-suite/src/index.ts::MODULES`

## Tests

- `external/pi-tools-suite/test/codex-reasoning-fix.test.ts`
- `external/pi-tools-suite/test/codex-reasoning-sdk-replay.test.ts`
- `external/pi-tools-suite/test/context-gateway/observe.test.ts`
- `external/pi-tools-suite/test/context-gateway/sdk-pipeline.test.ts`

## Verification

Reproduce from the repository root (the first four commands run inside the
suite; commands after `cd ../..` run from the root):

```sh
cd external/pi-tools-suite
bun test test/codex-reasoning-fix.test.ts test/codex-reasoning-sdk-replay.test.ts test/context-gateway/observe.test.ts test/context-gateway/sdk-pipeline.test.ts
npm run typecheck
env -u PIX_CONFIG_PROFILE -u PIX_ACP_SESSION_STATE_BRIDGE -u PIX_QUESTION_RPC_BRIDGE npm test
env -u PIX_CONFIG_PROFILE -u PIX_ACP_SESSION_STATE_BRIDGE -u PIX_QUESTION_RPC_BRIDGE npm run smoke
cd ../..
npm run sync:pi-tools-suite && npm run sync:pi-tools-suite:check
git diff --check
git diff -- specs/codex-reasoning-fix.md external/pi-tools-suite/README.md external/pi-tools-suite/src/codex-reasoning-fix/index.ts external/pi-tools-suite/src/index.ts external/pi-tools-suite/test/codex-reasoning-fix.test.ts external/pi-tools-suite/test/codex-reasoning-sdk-replay.test.ts
```

Observed on that date: 52 focused tests passed (0 failed); suite typecheck,
smoke, diff check/review, source-to-live sync and sync check passed. The full
suite with the three host-specific environment variables unset passed 986,
skipped 90, failed 0. With inherited `PIX_CONFIG_PROFILE=desktop`,
`PIX_ACP_SESSION_STATE_BRIDGE=1`, and `PIX_QUESTION_RPC_BRIDGE=1`, the full run
instead had seven native TUI failures; they disappeared with those variables
unset. Do not present the inherited-env run as a product regression or assume
the clean-host result will generalize to arbitrary environments.

Retained local diagnostic logs: `external/pi-tools-suite/.pi/artifacts/codex-focused-tests.log`,
`/tmp/codex-suite-clean-host.eBMZCY`, `/tmp/codex-suite-smoke.MSBHzF`, and
`/tmp/codex-suite-sync.5UW5nm`. These temporary/host-local paths are **not
permanent durable proof**; rerun the commands against the target revision.
