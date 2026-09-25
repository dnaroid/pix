/**
 * Wire-only workaround for legacy persisted reasoning signatures. The pi-ai
 * converter can replay a reasoning item with `content: null` or `content: []`.
 * Omit null to match the Responses schema, and empty arrays to match first-party
 * Codex serialization. This does not assert current ChatGPT endpoint rejection.
 * Upstream converter normalization is the durable fix, including WS continuation.
 */
type ExtensionAPI = any;

type ProviderRequestEvent = { payload?: unknown };
type ProviderRequestContext = { model?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return the original payload when no exact legacy reasoning field is found. */
export function stripReasoningContentFromPayload(payload: unknown, model: unknown): unknown {
	if (!isRecord(model) || (model.api !== "openai-responses" && model.api !== "openai-codex-responses")) {
		return payload;
	}
	if (!isRecord(payload) || !Array.isArray(payload.input)) return payload;

	let changed = false;
	const input = payload.input.map((item: unknown) => {
		if (!isRecord(item) || item.type !== "reasoning" ||
			!Object.prototype.hasOwnProperty.call(item, "content") ||
			(item.content !== null && !(Array.isArray(item.content) && item.content.length === 0))) {
			return item;
		}
		changed = true;
		const { content: _discard, ...rest } = item;
		return rest;
	});
	return changed ? { ...payload, input } : payload;
}

export default function codexReasoningFix(pi: ExtensionAPI): void {
	// Registered last within pi-tools-suite, not necessarily after other extensions.
	pi.on("before_provider_request", (event: ProviderRequestEvent, ctx: ProviderRequestContext) => {
		const result = stripReasoningContentFromPayload(event.payload, ctx.model);
		return result === event.payload ? undefined : result;
	});
}
