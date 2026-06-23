/**
 * WORKAROUND for @earendil-works/pi-ai bug: the Codex / OpenAI Responses API
 * rejects HTTP 400 `Unknown parameter: 'input[N].content'` when non-message
 * items (reasoning, function_call_output) carry a spurious `content` field.
 *
 * Root cause is in pi-ai's `convertResponsesMessages`, which pushes replayed
 * items verbatim including a stray `content` placeholder. The upstream fix is
 * uncommitted in pi-mono and never shipped, so every released pi-ai version
 * (incl. 0.79.10) is affected.
 *
 * The fix must run at the transport layer because the provider has TWO paths:
 *
 *  1. WebSocket-cached path (normal): `buildCachedWebSocketRequestBody` rebuilds
 *     the body into a DELTA after `before_provider_request`, so the hook never
 *     sees the bytes actually sent. We wrap `WebSocket.prototype.send` once and
 *     strip `content` from every non-message input item of each
 *     `response.create` frame, on the exact bytes leaving the socket.
 *
 *  2. SSE/fetch fallback path: once a websocket attempt fails (common at large
 *     context — full body, ~100+ input items), the transport records an SSE
 *     fallback for the session and every subsequent request goes through a plain
 *     `fetch()` POST with the FULL body (`bodyJson`). The `before_provider_request`
 *     hook should clean this, but in practice it does not reliably catch every
 *     offending item, so we also wrap `globalThis.fetch` once and strip the same
 *     spurious `content` from the request body on the exact bytes leaving the
 *     HTTP client.
 *
 * The `before_provider_request` hook is kept as a third secondary guard.
 *
 * Remove this whole module once an upstream pi-ai release carries the fix.
 */
type ExtensionAPI = any;

type ProviderRequestEvent = {
	payload?: unknown;
};

type ProviderRequestContext = {
	cwd?: string;
	model?: unknown;
};

installWireStripper();
installFetchStripper();

/**
 * Strip spurious `content` from any object that carries an `input` or
 * `messages` array. Shared core for the wire-frame, fetch, and hook paths.
 * Returns the cleaned object plus a tally only when something changed;
 * otherwise `undefined` (caller forwards the original untouched).
 */
export function stripCarrier(obj: unknown): { obj: Record<string, unknown>; stripped: number } | undefined {
	if (!isRecord(obj)) return undefined;
	const field = Array.isArray(obj.input) ? "input" : Array.isArray(obj.messages) ? "messages" : null;
	if (!field) return undefined;

	const list = obj[field] as unknown[];
	let stripped = 0;
	let changed = false;
	const next = new Array(list.length);
	for (let i = 0; i < list.length; i++) {
		const item = list[i];
		if (isSpuriousContentItem(item)) {
			const { content: _drop, ...rest } = item as Record<string, unknown>;
			next[i] = rest;
			stripped++;
			changed = true;
		} else {
			next[i] = item;
		}
	}
	if (!changed) return undefined;
	return { obj: { ...obj, [field]: next }, stripped };
}

/**
 * True only for items that carry a spurious `content`: an explicit `type` that
 * is NOT "message". Role-based messages (no `type`) and typed messages
 * (`type:"message"`) legitimately hold content — they are left untouched.
 */
function isSpuriousContentItem(item: unknown): boolean {
	return (
		isRecord(item) &&
		typeof item.type === "string" &&
		item.type !== "message" &&
		Object.prototype.hasOwnProperty.call(item, "content")
	);
}

/**
 * Wrap `WebSocket.prototype.send` once. For each `response.create` frame, strip
 * the offending `content` from non-message input items and forward the cleaned
 * frame. Forwards the original untouched on any parse/rewrite failure so the
 * transport never breaks.
 */
function installWireStripper(): void {
	try {
		const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
		if (!WS?.prototype) return;
		const proto = WS.prototype as { send?: unknown };
		if (typeof proto.send !== "function") return;
		const original = proto.send as (data: unknown) => void;
		if ((original as unknown as { __codexFixWrapped?: boolean }).__codexFixWrapped) return;

		const wrapped = function (this: unknown, data: unknown): void {
			let outgoing = data;
			if (typeof data === "string") {
				try {
					const parsed = JSON.parse(data);
					if (isRecord(parsed) && parsed.type === "response.create") {
						const result = stripCarrier(parsed);
						if (result) {
							outgoing = JSON.stringify(result.obj);
						}
					}
				} catch {
					// Non-JSON or malformed: forward untouched.
				}
			}
			return original.call(this, outgoing);
		};
		(wrapped as unknown as { __codexFixWrapped?: boolean }).__codexFixWrapped = true;
		proto.send = wrapped;
	} catch {
		// best-effort; never break on setup
	}
}

/**
 * Wrap `globalThis.fetch` once. For JSON POST bodies carrying an `input` or
 * `messages` array (Codex / OpenAI Responses shape), strip the spurious
 * `content` from non-message items before the request leaves the HTTP client.
 * This closes the SSE-fallback path that the WebSocket wrapper cannot see.
 * Forwards the original request untouched on any non-matching/parse failure.
 */
function installFetchStripper(): void {
	try {
		const g = globalThis as { fetch?: typeof fetch };
		const original = g.fetch;
		if (typeof original !== "function") return;
		if ((original as unknown as { __codexFixWrapped?: boolean }).__codexFixWrapped) return;

		const wrapped = function fetchStripper(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
			const nextInit = stripFetchInit(init);
			return original.call(this, input, nextInit ?? init);
		};
		(wrapped as unknown as { __codexFixWrapped?: boolean }).__codexFixWrapped = true;
		g.fetch = wrapped as typeof fetch;
	} catch {
		// best-effort; never break on setup
	}
}

/**
 * If `init` carries a JSON body shaped like a Responses request, return a new
 * `init` with the stripped body. Returns `undefined` when nothing matched so
 * the caller forwards the original `init` untouched.
 */
export function stripFetchInit(init: RequestInit | undefined): RequestInit | undefined {
	if (!init || typeof init.body !== "string") return undefined;
	try {
		const parsed = JSON.parse(init.body);
		const result = stripCarrier(parsed);
		if (!result) return undefined;
		return { ...init, body: JSON.stringify(result.obj) };
	} catch {
		return undefined;
	}
}

/**
 * If `frame` is a Codex `response.create` carrying an `input` (or `messages`)
 * array, return the cleaned frame plus a tally of stripped items. Returns
 * `undefined` when nothing matched (caller forwards the original frame
 * untouched). Exported for unit testing.
 */
export function stripContentFromWireFrame(frame: unknown): { frame: Record<string, unknown>; stripped: number } | undefined {
	if (!isRecord(frame) || frame.type !== "response.create") return undefined;
	const result = stripCarrier(frame);
	if (!result) return undefined;
	return { frame: result.obj, stripped: result.stripped };
}

export default function codexReasoningFix(pi: ExtensionAPI): void {
	pi.on("before_provider_request", async (event: ProviderRequestEvent, _ctx: ProviderRequestContext) => {
		const result = stripReasoningContentFromPayload(event.payload);
		return result === event.payload ? undefined : result;
	});
}

/**
 * Strip spurious `content` from non-message items in a full payload. Secondary
 * guard for the SSE-fallback / non-websocket path. Returns the same reference
 * when nothing changed; exported for unit testing.
 */
export function stripReasoningContentFromPayload(payload: unknown): unknown {
	const result = stripCarrier(payload);
	return result ? result.obj : payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
