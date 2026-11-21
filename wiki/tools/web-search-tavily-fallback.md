# Tavily fallback for web tools

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep `web_search` usable when the primary Ollama experimental web API fails, including when its usage limit is exhausted, by falling back to Tavily (when a key is configured) and then to keyless Brave Search. `web_fetch` reads public pages locally over Node HTTP(S) and extracts HTML to Markdown; it does not use any web API provider.

## Scope

- `web_search`: keep Ollama as the primary provider, using local Ollama by default and the official Ollama cloud API when an Ollama API key is configured. When an Ollama operation fails and a Tavily API key is configured, retry the search through Tavily Search. Keyless Brave Search HTML is the last `web_search` fallback.
- `web_fetch`: fetch and extract the page locally (Node HTTP(S) plus parse5-based Markdown extraction), for direct public HTTP(S) URLs only. It has no Ollama, Tavily, rdrr, or site API dispatch, and no fallback.
- Provide `/web-credentials` for interactive Ollama/Tavily key setup, status, and removal. These keys apply to `web_search` only.
- Preserve the existing tool names, parameters, formatted text, timeout, cancellation, and truncation behavior.

## Non-goals

- Accepting API keys through tool parameters or storing them in project files.
- Retrying a failed Tavily request through Ollama again.
- Adding a Tavily SDK dependency.
- Using Tavily Extract, Ollama `web_fetch`, rdrr (package, CLI or service), or any site API for `web_fetch`.
- Fetching `web_fetch` URLs with embedded credentials.

## Behavior

### web_search

1. Each search calls Ollama first. Without an Ollama key it uses the existing local experimental endpoint; with a key and no explicit `OLLAMA_HOST` it uses the official Ollama cloud endpoint with bearer authentication.
2. If Ollama succeeds, neither Tavily nor Brave is contacted.
3. If Ollama fails and no Tavily key is configured, the search skips Tavily and goes to Brave Search (step 6).
4. If Ollama fails and a Tavily key is configured, the search calls Tavily Search with bearer authentication.
5. Tavily Search results are normalized to the current title/URL/content result shape.
6. If Tavily is skipped or fails, `web_search` calls Brave Search: `GET https://search.brave.com/search?q=<query>&source=web` with no API key, through the system `curl` binary spawned without a shell (Brave answers HTTP 429 to Node/Bun TLS clients), with `--compressed`, a 4 MiB response cap and browser-like headers.
7. The Brave HTML is parsed locally with parse5; organic results are the `data-type="web"` snippets, sliced to `max_results`. A page without a recognizable results container is an error (`possible CAPTCHA or layout change`); HTTP 429 is a rate-limit error; a missing `curl` binary is a `curl is not installed` error.
8. If every provider fails, the error lists each provider failure in order (`<label> failed: ...`, then `<label> fallback also failed: ...`) without including any API key.
9. Result details identify the provider used (`ollama`, `tavily`, or `brave`). Fallback results include the first failure under `fallbackFrom` and every prior failure, in order, under `failures`.
10. `/web-credentials` stores or clears one provider key at a time and reports only whether each source is configured, never its value.

### web_fetch

1. Accepts only `http:` and `https:` URLs without embedded username or password; other input is rejected before any request.
2. Node `http`/`https` transport (no proxy agent) checks addresses at connection time: every DNS answer must be public, and the socket connects to a checked address. Private, loopback, link-local, mapped and reserved targets are refused, including redirect targets.
3. Follows at most 5 redirects; an HTTPS-to-HTTP redirect is refused.
4. Requests start with the reader profile: `User-Agent: Pix-Reader/1.0 (reader)` and `Accept: text/markdown,text/html;q=0.9,application/xhtml+xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.1`. The reader `User-Agent` deliberately has no `Mozilla` token: Hacker News answers HTTP 419 to a Mozilla UA on this Node TLS fingerprint. If the response status is 403, 429 or 503, the same URL is requested once more with the browser profile (`User-Agent` of Chrome 131 on macOS and `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`). The browser profile stays for the rest of that download, including redirects; the retry does not count toward the 5-redirect limit. Other non-2xx statuses (e.g. 404) are not retried, and a second 403/429/503 fails as `Page returned HTTP <status>.`. Both profiles send `Accept-Language: en-US,en;q=0.9` and `Accept-Encoding: identity`. Public-address checks, redirect revalidation, the HTTPS-to-HTTP refusal and the 1 MiB cap apply unchanged to the retry; some sites (e.g. StackOverflow) still answer 403 to both profiles. A response with a non-identity `Content-Encoding` is an error. Bodies over 1 MiB (by `Content-Length` or streamed bytes) are rejected.
5. Supported types: `text/html`, `application/xhtml+xml`, other `text/*`, and `application/json|xml|rss+xml|atom+xml|yaml`. Other types, including PDFs, are rejected. No JavaScript is executed and no site APIs are used. Markdown served by the site (`text/markdown`, e.g. react.dev or developers.cloudflare.com) is returned as text without extraction.
6. HTML is parsed with parse5 only (no rdrr dependency); Markdown is rendered locally. Content is taken from `main` (or `role="main"`), else `article`, else `body`. Forms, scripts, styles, hidden elements and screen-reader-only elements are removed, as is page chrome: elements whose class/id words mark ads, breadcrumbs, cookie notices, edit-section links, infoboxes, navboxes, sidebars, tables of contents, share widgets, footers, menus and similar (Readability-style; content words such as article/content/entry/main/post/story veto the match), and elements with roles `menu`, `menubar` or `toolbar`. Links are inline `[text](url)` for http(s) targets; same-site links are root-relative, with the origin given once in the `URL:` line. Same-document anchor links (permalinks, footnote markers) become plain text, and heading text has no links. Textless `javascript:` controls are removed. Lists that are at least 80% link text and link bars (three or more short links separated only by separators) are dropped. Layout tables (role `presentation`/`none`, nested tables, single row or column, or small tables without `th`/`thead`/`caption`) are flattened; data tables stay Markdown pipe tables. Images become their alt text, and duplicate alt texts are kept once. Whitespace-only lines, dangling `|` separators and leading/trailing `---` are tidied outside code fences. An H1 that repeats the page title is removed.
7. Title comes from `<title>`, falling back to the first `h1`; a missing title is shown as `Untitled`. Output is `Title: <title>`, `URL: <final URL after redirects>`, a blank line, then `Content:` and the Markdown, truncated with the same limit as other tool output.
8. Empty extracted content is an error (`No readable content found.`).
9. Details: `title`, `content`, `contentBytes`, `provider: "local"`, `host` (original URL origin), `timeoutMs`, and `truncated`. There is no `links` field and no fallback provider.
10. `timeout_ms` / `PI_WEB_SEARCH_TIMEOUT_MS` bound the whole fetch, including redirects, download and processing. Parent cancellation aborts the request.
11. No API key is read or sent.

## Contracts

- Secret inputs for `web_search`: `/web-credentials`, `OLLAMA_API_KEY`, and `TAVILY_API_KEY`; environment variables take precedence over stored keys. `web_fetch` takes no secret input.
- Key pages shown by `/web-credentials`: `https://ollama.com/settings/keys` and `https://app.tavily.com/home`.
- Stored credential path: user-level `~/.config/pi/pi-tools-suite-credentials.json`, written atomically with file mode `0600`.
- Ollama cloud search endpoint: `POST https://ollama.com/api/web_search`.
- Tavily search endpoint: `POST https://api.tavily.com/search`.
- Brave fallback endpoint: `GET https://search.brave.com/search?q=<query>&source=web`; no key, fetched via system `curl`, 4 MiB cap.
- Authentication for search: provider-specific `Authorization: Bearer <API key>`; Brave Search uses none.
- `timeout_ms` and `PI_WEB_SEARCH_TIMEOUT_MS` apply independently to each `web_search` provider request (Ollama, Tavily, Brave). For `web_fetch` they bound the whole fetch, download and extraction.
- `web_fetch` has no `rdrr` dependency; `parse5` (pinned in `external/pi-tools-suite/package.json`) parses HTML only.

## Edge cases

- Parent cancellation cancels the active provider request and does not start a later search provider (Tavily or Brave) after cancellation. `web_fetch` reports `web_fetch request was cancelled.`
- `web_fetch` timeout reports `web_fetch request timed out after <N>ms.`; other failures are reported as `web_fetch failed: <reason>`.
- Invalid Tavily JSON, non-success HTTP responses, and unexpected response shapes produce provider-specific errors.
- Tavily Search supports at most 20 results; fallback requests clamp `max_results` to that documented maximum.
- Clearing a stored key does not unset an environment override; status and notifications make that precedence visible without exposing the key.

## Verification

- `web_search`: Ollama success without fallback; Tavily Search fallback request/response mapping; keyless Brave fallback when no Tavily key exists; Brave CAPTCHA page reporting all three failures; missing keys, cancellation, and dual-provider failures; stored key permissions, immediate activation, status, and removal.
- `web_fetch` (`external/pi-tools-suite/test/web-search.test.ts`): no search keys or authorization header sent; rejection of non-HTTP(S) URLs and embedded credentials; cancellation and timeout without search providers.
- `web_fetch` reader (`external/pi-tools-suite/test/web-fetch-reader.test.ts`): main/article/body extraction and inline Markdown links; page-chrome, anchor, link-bar, layout-table and duplicate-alt cleanup; data tables and long headline links kept; private literals and DNS answers; relative redirects, redirect limit, HTTPS downgrade and private redirect refusal; browser-profile retry after 403/429/503 kept across redirects, no retry for other statuses, second block fails; 1 MiB cap, unsupported types and cancelled bodies.
- `npm --prefix external/pi-tools-suite run check`
- Host `npm run check`

## Risks / unknowns

- A search fallback can consume Tavily credits for any Ollama failure, not only quota errors; this is intentional.
- Up to three search provider attempts (Ollama, Tavily when keyed, Brave) can make total elapsed time approach three times `timeout_ms` (two without a Tavily key).
- Brave fallback is best-effort HTML parsing of a public page, not a documented API: it can be throttled (HTTP 429), serve CAPTCHA pages, or break on layout changes, and then fails.
- Extraction quality on JavaScript-heavy or login-protected pages was not evaluated for this change.

## Evidence

- Confirmed by code: `external/pi-tools-suite/src/web-search/index.ts` (`web_search` fallback chain and `web_fetch` tool), `src/web-search/brave-search.ts` (Brave URL, curl transport, HTML parsing), `src/web-search/public-page.ts` (transport, address checks, redirects, limits), `src/web-search/page-markdown.ts` (parse5-based extraction).
- Confirmed by tests: `external/pi-tools-suite/test/web-search.test.ts` (Ollama, Tavily and Brave search shapes and chain; `web_fetch` cancellation and timeout) and `external/pi-tools-suite/test/web-fetch-reader.test.ts` (reader and transport limits).
- Confirmed by docs: Tavily REST base URL, bearer auth, Search response, and Search maximum of 20 results.
- User decision: fallback on every Ollama error for `web_search`.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"ffb1d72dfde6125ea113aee762c634710d7607ad1684aace77db64c69e9b4354","checkedAt":"2026-11-21T17:51:28.313Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":46,"reportLanguage":"ru"} -->
