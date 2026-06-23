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
 * The fix must run at the WebSocket.send layer, not at before_provider_request:
 * pi's openai-codex-responses provider uses a websocket-cached transport that
 * rebuilds the body into a delta AFTER the before_provider_request hook, so the
 * hook never sees the bytes actually sent. This module wraps
 * WebSocket.prototype.send once and strips `content` from every non-message
 * input item of each `response.create` frame, on the exact bytes leaving the
 * socket. The before_provider_request hook is kept as a secondary guard for the
 * SSE-fallback transport (full body, no delta).
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

/**
 * Wrap WebSocket.prototype.send once. For each `response.create` frame, strip
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
					const result = stripContentFromWireFrame(parsed);
					if (result) {
						outgoing = JSON.stringify(result.frame);
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
 * If `frame` is a Codex `response.create` carrying an `input` (or `messages`)
 * array, return the cleaned frame (content stripped from every non-message
 * item) plus a tally of how many items were stripped. Returns `undefined`
 * when nothing matched (caller forwards the original frame untouched). The
 * returned `frame` is a clean Codex payload with no extra fields.
 */
export function stripContentFromWireFrame(frame: unknown): { frame: Record<string, unknown>; stripped: number } | undefined {
	if (!isRecord(frame) || frame.type !== "response.create") return undefined;
	const field = Array.isArray(frame.input) ? "input" : Array.isArray(frame.messages) ? "messages" : null;
	if (!field) return undefined;

	const list = frame[field] as unknown[];
	let stripped = 0;
	let changed = false;
	const next = new Array(list.length);
	for (let i = 0; i < list.length; i++) {
		const item = list[i];
		// Only items with an explicit `type` that is NOT "message" can carry a
		// spurious `content`. Role-based messages (no `type`) and typed
		// messages (`type:"message"`) legitimately hold content — leave them.
		if (
			isRecord(item) &&
			typeof item.type === "string" &&
			item.type !== "message" &&
			Object.prototype.hasOwnProperty.call(item, "content")
		) {
			const { content: _drop, ...rest } = item;
			next[i] = rest;
			stripped++;
			changed = true;
		} else {
			next[i] = item;
		}
	}
	if (!changed) return undefined;
	return { frame: { ...frame, [field]: next }, stripped };
}

export default function codexReasoningFix(pi: ExtensionAPI): void {
	pi.on("before_provider_request", async (event: ProviderRequestEvent, _ctx: ProviderRequestContext) => {
		const result = stripReasoningContentFromPayload(event.payload);
		return result === event.payload ? undefined : result;
	});
}

/**
 * Strip spurious `content` from non-message items in a full payload. Secondary
 * guard for the SSE-fallback / non-websocket path. Same rule as the wire
 * stripper; exported for unit testing.
 */
export function stripReasoningContentFromPayload(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	const inputList = Array.isArray(payload.input) ? payload.input : undefined;
	const messagesList = Array.isArray(payload.messages) ? payload.messages : undefined;
	const field = inputList ? "input" : messagesList ? "messages" : undefined;
	const list = inputList ?? messagesList;
	if (!field || !list) return payload;

	let changed = false;
	const next = new Array(list.length);
	for (let i = 0; i < list.length; i++) {
		const item = list[i];
		if (
			isRecord(item) &&
			typeof item.type === "string" &&
			item.type !== "message" &&
			Object.prototype.hasOwnProperty.call(item, "content")
		) {
			const { content: _drop, ...rest } = item;
			next[i] = rest;
			changed = true;
		} else {
			next[i] = item;
		}
	}
	if (!changed) return payload;
	return { ...payload, [field]: next };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
