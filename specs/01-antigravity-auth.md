# 01 — antigravity-auth (as-is spec)

> Risk class: **auth / security / privacy**. Google "Antigravity" OAuth provider
> for pi: login, refresh-token rotation across a pool of accounts, multi-account
> failover on quota/capacity errors, and import from opencode's account store.

## Purpose

Register pi provider `antigravity` backed by Google OAuth (the Antigravity /
cloudcode-pa gateway), manage a pool of OAuth accounts in `~/.pi/agent/auth.json`,
and transparently rotate/fail over accounts when the active one hits quota or
capacity limits. `[confirmed by code: src/antigravity-auth/index.ts]`

## Current behavior

### Provider registration & lifecycle
- Registers provider id `antigravity`, API id `antigravity-unified-gateway`, base URL `ENDPOINT_DAILY` (`https://daily-cloudcode-pa.sandbox.googleapis.com`). `[confirmed by code: index.ts, constants.ts]`
- Registers an `oauth` adapter: `login = loginAntigravity`, `refreshToken = refreshAntigravityToken`, `getApiKey = (c) => c.access`, `modifyModels` attaches `antigravityProjectId` from the access token (or effective project id). `[confirmed by code: index.ts]`
- Registers commands: `/antigravity-add-account`, `/antigravity-account`, `/antigravity-status` (alias). `[confirmed by code: index.ts]`
- Listens to `message_end`; when an assistant message has `provider === "antigravity"`, `stopReason === "error"`, and an error message, it surfaces a provider-failure notification (deduped per model+message within 60s). `[confirmed by code: index.ts, status.ts]`
- Publishes a startup section listing accounts in `auth.json`. `[confirmed by code: status.ts]`

### Secret encoding (custom, pipe-delimited)
- **API key / access token** = `access|projectId` (decoded by `decodeApiKey`). `[confirmed by code: auth-store.ts]`
- **Refresh token** = `refreshToken|projectId|managedProjectId`; `splitRefresh`/`joinRefresh` round-trip it. `getEffectiveProjectId` returns projectId or managedProjectId. `[confirmed by code: auth-store.ts]`
- Default project id is a hardcoded constant `DEFAULT_PROJECT_ID = "rising-fact-p41fc"`. `[confirmed by code: constants.ts]`

### Login (OAuth Authorization Code + PKCE) — `loginAntigravity`
1. Reads Google OAuth client credentials (clientId, optional clientSecret) from stored auth, multiple key aliases, or env `PI_ANTIGRAVITY_GOOGLE_CLIENT_ID` / `PI_ANTIGRAVITY_GOOGLE_CLIENT_SECRET`. Throws if no clientId. `[confirmed by code: auth-store.ts getGoogleOAuthClientCredentials, oauth.ts assertGoogleOAuthCredentialsConfigured]`
2. Generates PKCE verifier/challenge (`randomBytes(32)` → base64url; challenge = sha256). `[confirmed by code: oauth.ts]`
3. Builds Google auth URL (`accounts.google.com/o/oauth2/v2/auth`, redirect `http://localhost:51121/oauth-callback`, scopes incl. `cloud-platform`, `userinfo.email/profile`, `cclog`, `experimentsandconfigs`, `access_type=offline`, `prompt=consent`). State = base64url JSON `{verifier}`. `[confirmed by code: oauth.ts, constants.ts]`
4. Asks the user to paste the full `localhost:51121/oauth-callback` URL (or `code#state`). Parses code+state, **verifies state verifier matches** (CSRF guard). `[confirmed by code: oauth.ts]`
5. Token exchange at `oauth2.googleapis.com/token`; requires a `refresh_token` in the response or throws. `[confirmed by code: oauth.ts]`
6. Fetches `projectId` (POST to each `LOAD_ENDPOINTS` `/v1internal:loadCodeAssist`) and user email (`googleapis.com/oauth2/v1/userinfo`) in parallel. Falls back to `DEFAULT_PROJECT_ID`. `[confirmed by code: oauth.ts, constants.ts]`

### Add account — `addAntigravityAccount`
- Logs in, builds an account object, dedupes against stored accounts by **email (case-insensitive) then refreshToken** (`findMatchingAccountIndex`), updates-in-place or pushes new. `[confirmed by code: auth-store.ts, oauth.ts]`
- Decides activation by: explicit `activate` flag, no existing credential, only one account, or active index already points at this account. `[confirmed by code: oauth.ts]`
- Writes merged auth via `writeJsonFileSecure`. `[confirmed by code: oauth.ts]`

### Refresh & rotation
- `refreshAntigravityToken` (the pi adapter refresh): rotates to the **next** account `(activeIndex + 1) % count` every time it's called, refreshes that account's token, and writes back. With no stored accounts it refreshes the single top-level refresh token. `[confirmed by code: oauth.ts]`
- `refreshStoredAntigravityCredential`: refreshes the account at the (clamped) active index, persists updated refresh/access, updates that one account entry in the `accounts` array. `[confirmed by code: oauth.ts]`
- `refreshNextFailoverCredential(attempted)`: iterates accounts offset 1..N skipping already-attempted indices, refreshes the first that succeeds, persists; if all fail, rethrows the last error. `[confirmed by code: oauth.ts]`

### Streaming + failover — `streamAntigravity`
- Resolves an API key: uses stored `access` if not expired, else calls `refreshStoredAntigravityCredential`; throws `No Antigravity OAuth account found in Pi auth: <path>` otherwise. `[confirmed by code: stream.ts resolveAntigravityApiKey]`
- Sends `POST {endpoint}/v1internal:streamGenerateContent?alt=sse` with `Authorization: Bearer <access>` and Antigravity headers. Endpoint list: `gemini-cli` models use `[ENDPOINT_PROD]`; others use `STREAM_ENDPOINTS` (daily, autopush, prod), trying next endpoint only on non-failover 404/5xx. `[confirmed by code: stream.ts, constants.ts]`
- On a **failover-candidate** response (HTTP 429; body containing `quota_exhausted`/`resource_exhausted`/`rate limit`/etc.; or `model_capacity_exhausted`/`overloaded`/`busy`; or 5xx with `unavailable`/`try again`/`busy`): calls `refreshNextFailoverCredential`, switches `access` + `project`, emits a `switch` status, and retries. `[confirmed by code: stream.ts isFailoverCandidate/isLimitFailoverCandidate]`
- When all accounts are tried **and** the failure was a *limit* (quota/rate) failure, the error includes marker `ANTIGRAVITY_ALL_ACCOUNTS_EXHAUSTED model=<id> status=<n>`. Non-limit capacity failures (e.g. plain 503) report `Antigravity request failed (<status>)` without the all-exhausted marker. `[confirmed by code: stream.ts; confirmed by tests]`
- Parses SSE (`data:` frames), maps text/thinking/functionCall parts, computes usage/cost, maps stop reasons (`STOP`→stop, `MAX_TOKENS`→length). `[confirmed by code: stream.ts]`

### Import from opencode — `importOpencodeAntigravityAccount`
- Reads opencode `antigravity-accounts.json` (path from `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME` / `~/.config/opencode`), selects by index/email or active index, and writes into pi auth. `[confirmed by code: auth-store.ts]`
- Refuses to overwrite an existing, different credential unless `overwrite` is set (returns reason `auth-exists-use-force`). Returns `already-imported` when refresh matches. `[confirmed by code: auth-store.ts]`

## Public contracts / inputs / outputs

- **Secret file**: `~/.pi/agent/auth.json` (`PI_AUTH_PATH`). Test override: env `PI_TOOLS_SUITE_TEST_AUTH_PATH` only when `NODE_ENV === "test"`. `[confirmed by code: auth-store.ts]`
- **File format**: JSON map keyed by provider id (`antigravity`): `{ type:"oauth", refresh, access, expires, email?, oauthClient?:{clientId,clientSecret?}, accounts:OpencodeAntigravityAccount[], activeIndex }`. `[confirmed by code: auth-store.ts, oauth.ts]`
- **Slash commands** (string args): `/antigravity-add-account [--email X] [--activate]`, `/antigravity-account`, `/antigravity-status`. `[confirmed by code: index.ts, commands.ts]`
- **Provider contract**: `streamSimple(model, context, options)` → AssistantMessageEventStream; `oauth.login`/`oauth.refreshToken` per pi-ai `OAuthCredentials` shape. `[confirmed by code: index.ts, stream.ts]`

## Invariants

- `auth.json` is written atomically-ish with `mode: 0o600` and re-`chmod` 0o600 (best-effort) on every write. `[confirmed by code: auth-store.ts writeJsonFileSecure]`
- Login never proceeds without an OAuth state-verifier match. `[confirmed by code: oauth.ts]`
- Token expiry is stored skewed: `expires = start + expires_in*1000 - TOKEN_EXPIRY_SKEW_MS` (5 min). `[confirmed by code: oauth.ts, constants.ts]`
- Account pool membership = accounts with `enabled !== false` and a non-empty refresh token (`getStoredAccounts`). `[confirmed by code: auth-store.ts]`

## Edge cases

- `decodeApiKey("")` returns `{access:"", projectId:undefined}`; empty access is treated as missing. `[confirmed by code: auth-store.ts]`
- `splitRefresh` falls back to the whole string as `refreshToken` when no `|`. `[confirmed by code: auth-store.ts]`
- Failover loop stops immediately if `options.signal.aborted`. `[confirmed by code: stream.ts]`
- `addAntigravityAccount` seeds the accounts array from a legacy single top-level credential when the array is empty. `[confirmed by code: oauth.ts]`
- If `loadCodeAssist`/userinfo fetch fail, projectId defaults to `DEFAULT_PROJECT_ID` and email may be omitted. `[confirmed by code: oauth.ts]`
- Read of a missing `auth.json` returns `{}` (ENOENT tolerated; other errors rethrown). `[confirmed by code: auth-store.ts readJsonFile]`

## Side effects

- Writes `~/.pi/agent/auth.json` (0o600) on login, add-account, every refresh (rotation + stored refresh + failover), and opencode import. `[confirmed by code]`
- Outbound network to: `accounts.google.com`, `oauth2.googleapis.com`, `googleapis.com/oauth2/v1/userinfo`, and the Antigravity `cloudcode-pa` endpoints (prod/daily/autopush). `[confirmed by code: oauth.ts, stream.ts, constants.ts]`
- Emits UI/session status messages and provider-failure notifications. `[confirmed by code: status.ts]`

## Related files

- `external/pi-tools-suite/src/antigravity-auth/index.ts` — provider/command registration, event wiring
- `.../auth-store.ts` — secret file I/O, key/refresh encoding, opencode import, account selection
- `.../oauth.ts` — login, add-account, refresh/rotation/failover
- `.../stream.ts` — SSE streaming, failover loop, quota detection
- `.../status.ts` — status/notification helpers
- `.../constants.ts` — provider ids, endpoints, scopes, redirect URI, project id
- `.../headers.ts`, `.../payload.ts`, `.../models.ts`, `.../types.ts`, `.../commands.ts`

## Existing tests

- `external/pi-tools-suite/test/antigravity-auth.test.ts` (`bun:test`, `describe.serial "Antigravity account rotation"`): `[confirmed by tests]`
  - OAuth client credentials preserved across refresh.
  - Client credentials resolved from env when `auth.json` has only accounts.
  - No-account turn surfaces an error notification (deduped to one).
  - Opencode accounts are **not** auto-imported at request time (no fetch).
  - `ANTIGRAVITY_ALL_ACCOUNTS_EXHAUSTED` emitted only after trying every account for the model (rotates `access-0`→`access-1`, refreshes `refresh-1`, sets `activeIndex=1`, emits one `switch`).
  - Non-limit 503 does **not** emit the all-exhausted marker.

## Gaps / risks

- **Round-robin on every refresh**: `refreshAntigravityToken` advances `activeIndex` on each call, so the active account churns even without failures; combined with failover this can mask which account is "primary". `[confirmed by code: oauth.ts]`
- **Custom pipe-delimited token encoding** means any tooling that rewrites `auth.json` without preserving the `access|projectId` / `refresh|projectId|managedProjectId` shape silently corrupts credentials. `[inferred]`
- **Hardcoded default project id** (`rising-fact-p41fc`) is embedded in source and used as a fallback. `[confirmed by code: constants.ts]`
- **Failover is per-process, in-memory**: the `attemptedAccountIndices` set is local to one `streamAntigravity` call; there is no cross-turn or cross-process coordination, so concurrent requests can each hammer all accounts. `[confirmed by code: stream.ts; inferred re: concurrency]`
- **chmod is best-effort** (`.catch(() => undefined)`); on filesystems that ignore mode the file may not be 0o600. `[confirmed by code: auth-store.ts]`
- **Token contents in plaintext JSON**; if a refresh token rotates (Google sometimes returns a new one), the old one is overwritten — there is no backup/rotation audit. `[inferred]`
- **No unit tests** for `streamAntigravity` happy-path SSE parsing, multi-endpoint fallback ordering, or `importOpencodeAntigravityAccount` overwrite/already-imported branches (only covered indirectly). `[inferred]`
- **What happens when Google revokes a refresh token** (returns an error on refresh) is not specially handled beyond throwing; it will keep failing every turn until the user re-adds. `[inferred]`

## Suggested verification

1. Confirm `auth.json` mode is `0o600` after a real add-account and a real refresh on the target OS (`ls -l ~/.pi/agent/auth.json`). `[addresses chmod invariant]`
2. Add a test asserting `decodeApiKey(encodeApiKey(a, p))` round-trips, including empty project id. `[addresses encoding risk]`
3. Add a unit test for `refreshNextFailoverCredential` exhausting all accounts and rethrowing the last error, and for the empty-accounts case. `[addresses failover coverage]`
4. Add a test that a Google refresh-token revocation error propagates as a provider failure notification without an infinite loop (the `sendSessionMessage:false` guard exists for this). `[addresses revoke behavior]`
5. Verify opencode-import `auth-exists-use-force` vs `already-imported` vs `imported:true` branches with fixtures. `[addresses import coverage]`
