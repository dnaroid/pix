/**
 * WORKAROUND for @earendil-works/pi-ai bug: the Codex / OpenAI Responses API
 * rejects HTTP 400 `Unknown parameter: 'input[N].content'` when non-message
 * items (reasoning, function_call_output) carry a spurious `content` field.
 *
 * Stray fields can come from replayed pi-ai items or from another extension
 * that modifies the provider payload. The sanitizer therefore must be the
 * LAST `before_provider_request` handler registered by pi-tools-suite.
 *
 * In pi-ai >= 0.80.6 the final `before_provider_request` payload feeds both the
 * WebSocket delta builder and the zstd-compressed SSE fallback body. Running the
 * sanitizer last therefore covers both transports without mutating global
 * `fetch` or `WebSocket.prototype.send`.
 *
 * Module registration order is part of this workaround's correctness.
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

/**
 * Strip spurious `content` from any object that carries an `input` or
 * `messages` array. Shared core for payload sanitization.
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

export default function codexReasoningFix(pi: ExtensionAPI): void {
	// src/index.ts deliberately registers this module last. A later payload
	// modifier could otherwise reintroduce invalid content after sanitization,
	// and transport encoding happens after this hook.
	pi.on("before_provider_request", async (event: ProviderRequestEvent, _ctx: ProviderRequestContext) => {
		const result = stripReasoningContentFromPayload(event.payload);
		return result === event.payload ? undefined : result;
	});
}

/**
 * Strip spurious `content` from non-message items in a full payload. Returns the same reference
 * when nothing changed; exported for unit testing.
 */
export function stripReasoningContentFromPayload(payload: unknown): unknown {
	const result = stripCarrier(payload);
	return result ? result.obj : payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
