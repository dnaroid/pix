# 06 — OpenAI Codex usage-token refresh

> Risk class: **authentication / persistence**. The quota indicator shares the
> `openai-codex` OAuth credential with pi model requests.

## Purpose

Keep the model-usage `statusLabel` available when the OpenAI Codex access token
expires, without consuming a rotated refresh token behind pi core's back.

## Behavior

- A valid access token is used directly for the ChatGPT usage request.
- An expired pi `openai-codex` OAuth credential is refreshed through
  `AuthStorage.getApiKey()` from `@earendil-works/pi-coding-agent`.
- The refreshed credential is then used for the usage request.
- If refresh fails, the model-usage query rejects instead of returning
  `undefined`; `ModelUsageController` therefore retains its previous status.
- Missing or non-OAuth credentials still produce no status.

## Persistence invariant

OpenAI's refresh response includes a replacement `refresh_token`. Refresh must
therefore use pi core's file-backed `AuthStorage`, which locks `auth.json`,
re-reads it under the lock, persists the complete rotated credential, and
avoids duplicate refreshes across processes. A standalone in-memory refresh is
intentionally not implemented because it could invalidate the refresh token
still stored by pi core and break subsequent model requests.

## Side effects

- Expired credentials can trigger a POST to
  `https://auth.openai.com/oauth/token`.
- A successful refresh atomically updates the `openai-codex` entry in
  `~/.pi/agent/auth.json` (or the test override path) via pi core.
- The quota request remains
  `https://chatgpt.com/backend-api/wham/usage`.

## Verification

- Regression test: an expired credential is refreshed, the rotated refresh
  token is persisted, and the quota request uses the new access token.
- Regression test: a failed refresh rejects so the controller's established
  “keep previous value” path remains active.
- Run `npm run check` and `npm run test:tools-suite`.
