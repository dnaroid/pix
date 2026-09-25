---
kind: spec
status: active
---

# Codex reasoning replay wire workaround

## Behavior

The suite's `before_provider_request` hook removes the own `content` property
only from `type: "reasoning"` entries in `payload.input` when the property is
exactly `null` or an empty array and the selected `ctx.model.api` is exactly
`openai-responses` or `openai-codex-responses`. Installed pi-ai can replay old
persisted thinking signatures as reasoning input with these fields. Omitting
empty arrays matches first-party Codex serialization; omitting null matches
the optional, non-nullable Responses schema field. This is not proof of a
current rejection by the ChatGPT Codex endpoint. A changed payload, input array, and affected
items are copied; originals are never mutated. No change returns the original
reference (and the hook returns `undefined`).

## Constraints and failure cases

Nonempty or malformed reasoning content, absent content, other item types,
`messages`, unrelated APIs, and non-array input are passthrough. The hook does
not inspect provider/model names or remove `prompt_cache_retention`; custom
OpenAI-compatible models may legitimately emit that legacy field. This is a
wire workaround, not persisted-session normalization. It registers last within
the suite, but other extensions can register later hooks: this is not a global
final-payload guarantee. Upstream pi-ai converter normalization is the lasting
remedy; no transport or SDK source is patched here.

In installed pi-ai's cached Codex WebSocket path,
`getCachedWebSocketInputDelta` compares the sanitized current request prefix
with `lastRequestBody.input + lastResponseItems`. The latter is independently
converted from the assistant response and may retain `content: null` or `[]`.
That mismatch invalidates continuation and sends full context instead of a
delta. The bounded regression demonstrates this **known limitation**, not a
continuation fix. SSE and WebSocket send the sanitized request body, subject
to any later extension hooks.

## Implementation

- `external/pi-tools-suite/src/codex-reasoning-fix/index.ts`
- `external/pi-tools-suite/src/index.ts::MODULES`

## Tests

- `external/pi-tools-suite/test/codex-reasoning-fix.test.ts`
- `external/pi-tools-suite/test/codex-reasoning-sdk-replay.test.ts`
- `external/pi-tools-suite/test/context-gateway/sdk-pipeline.test.ts`

## Verification

Run the three focused tests and suite typecheck. The replay tests use the
installed pi-ai converter and builder without a backend request; the cached
WebSocket mismatch test mirrors the installed SDK's prefix comparison rather
than claiming transport integration or restored delta continuation.

Protocol evidence: [Codex serializer](https://github.com/openai/codex/blob/7dae8c53/codex-rs/protocol/src/models.rs)
omits empty arrays, but currently serializes absent content as null;
[issue #47733](https://github.com/openai/codex/issues/47733) reports a strict
third-party Responses provider rejecting that null and documents the schema.
No live backend A/B is part of these checks. Remove the extension after upstream
replay normalization covers both request input and the continuation baseline.
