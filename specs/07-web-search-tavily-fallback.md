# Spec: Tavily fallback for web tools

## Type

Change

## Goal

Keep `web_search` and `web_fetch` usable when the primary Ollama experimental web API fails, including when its usage limit is exhausted.

## Scope

- Keep Ollama as the primary provider.
- Use local Ollama by default and the official Ollama cloud API when an Ollama API key is configured.
- When an Ollama operation fails and a Tavily API key is configured, retry the same operation through Tavily.
- Map `web_search` to Tavily Search and `web_fetch` to Tavily Extract.
- Provide `/web-credentials` for interactive Ollama/Tavily key setup, status, and removal.
- Preserve the existing tool names, parameters, formatted text, timeout, cancellation, and truncation behavior.

## Non-goals

- Accepting API keys through tool parameters or storing them in project files.
- Retrying a failed Tavily request through Ollama again.
- Adding a Tavily SDK dependency.

## Behavior

1. Each operation calls Ollama first. Without an Ollama key it uses the existing local experimental endpoint; with a key and no explicit `OLLAMA_HOST` it uses the official Ollama cloud endpoint with bearer authentication.
2. If Ollama succeeds, Tavily is not contacted.
3. If Ollama fails and no Tavily key is configured, the original Ollama error is returned.
4. If Ollama fails and a Tavily key is configured, the operation calls Tavily with bearer authentication.
5. Tavily Search results are normalized to the current title/URL/content result shape.
6. Tavily Extract content is normalized to the current title/content/links shape; Tavily does not supply page title or links, so the requested URL is used as the title and links are empty.
7. If both providers fail, the error reports both provider failures without including the API key.
8. Result details identify the provider used and, for fallback results, include the Ollama failure message.
9. `/web-credentials` stores or clears one provider key at a time and reports only whether each source is configured, never its value.

## Contracts

- Secret inputs: `/web-credentials`, `OLLAMA_API_KEY`, and `TAVILY_API_KEY`; environment variables take precedence over stored keys.
- Key pages shown by `/web-credentials`: `https://ollama.com/settings/keys` and `https://app.tavily.com/home`.
- Stored credential path: user-level `~/.config/pi/pi-tools-suite-credentials.json`, written atomically with file mode `0600`.
- Ollama cloud endpoints: `POST https://ollama.com/api/web_search` and `POST https://ollama.com/api/web_fetch`.
- Tavily endpoints: `POST https://api.tavily.com/search` and `POST https://api.tavily.com/extract`.
- Authentication: provider-specific `Authorization: Bearer <API key>`.
- Existing `timeout_ms` and `PI_WEB_SEARCH_TIMEOUT_MS` apply independently to each provider request.

## Edge cases

- Parent cancellation cancels the active provider request and does not start a fallback after cancellation.
- Invalid Tavily JSON, non-success HTTP responses, and unexpected response shapes produce provider-specific errors.
- Tavily Search supports at most 20 results; fallback requests clamp `max_results` to that documented maximum.
- A Tavily Extract response with only `failed_results` is treated as an error.
- Clearing a stored key does not unset an environment override; status and notifications make that precedence visible without exposing the key.

## Related files

- `external/pi-tools-suite/src/web-search/index.ts`
- `external/pi-tools-suite/src/tool-descriptions.ts`
- `external/pi-tools-suite/test/web-search.test.ts`
- `external/pi-tools-suite/README.md`

## Verification

- Unit tests for Ollama success without fallback.
- Unit tests for Search and Extract fallback request/response mapping.
- Unit tests for missing keys, cancellation, and dual-provider failures.
- Unit tests for stored key permissions, immediate activation, status, and removal.
- `npm --prefix external/pi-tools-suite run check`
- Host `npm run check`

## Risks / unknowns

- A fallback can consume Tavily credits for any Ollama failure, not only quota errors; this is intentional.
- The two provider attempts can make total elapsed time approach twice `timeout_ms`.

## Evidence

- Confirmed by code: current Ollama request, timeout, cancellation, formatting, and details contracts.
- Confirmed by tests: current Ollama request shapes and error behavior.
- Confirmed by docs: Tavily REST base URL, bearer auth, Search response, Extract response, and Search maximum of 20 results.
- User decision: fallback on every Ollama error for both tools.
