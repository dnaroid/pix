/**
 * WORKAROUNDS for Codex / OpenAI Responses payload compatibility:
 * - non-message items (reasoning, function_call_output) must not carry the
 *   spurious `content` field rejected with HTTP 400;
 * - the Codex backend rejects the legacy `prompt_cache_retention` field for
 *   all current models, while direct OpenAI GPT-5.6+ uses the newer prompt
 *   cache options shape.
 *
 * The sanitizer must be the LAST `before_provider_request` handler registered
 * by pi-tools-suite so another payload hook cannot undo these guards.
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

const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_PROVIDER = "openai";

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
	pi.on("before_provider_request", async (event: ProviderRequestEvent, ctx: ProviderRequestContext) => {
		const result = sanitizeCodexProviderPayload(event.payload, ctx.model);
		return result === event.payload ? undefined : result;
	});
}

/**
 * Apply all final Codex payload compatibility guards. Returns the original
 * reference when no guard changes the payload.
 */
export function sanitizeCodexProviderPayload(payload: unknown, model: unknown): unknown {
	const contentSanitized = stripReasoningContentFromPayload(payload);
	return stripUnsupportedPromptCacheRetention(contentSanitized, model);
}

/**
 * Strip spurious `content` from non-message items in a full payload. Returns the same reference
 * when nothing changed; exported for unit testing.
 */
export function stripReasoningContentFromPayload(payload: unknown): unknown {
	const result = stripCarrier(payload);
	return result ? result.obj : payload;
}

/**
 * Remove legacy prompt-cache retention only where it is known to be rejected:
 * every current Codex model, and direct OpenAI GPT-5.6 or newer. Match the
 * selected model rather than a bare payload id so other providers keep the
 * field untouched.
 */
export function stripUnsupportedPromptCacheRetention(payload: unknown, model: unknown): unknown {
	if (!isRecord(payload) || !Object.prototype.hasOwnProperty.call(payload, "prompt_cache_retention")) {
		return payload;
	}
	if (!rejectsLegacyPromptCacheRetention(model, payload.model)) return payload;

	const { prompt_cache_retention: _drop, ...rest } = payload;
	return rest;
}

function rejectsLegacyPromptCacheRetention(model: unknown, payloadModel: unknown): boolean {
	const selected = modelIdentity(model);
	if (selected.provider !== undefined) {
		return isAffectedProviderModel(selected.provider, selected.id);
	}
	if (selected.id?.includes("/")) {
		return isAffectedQualifiedModel(selected.id);
	}

	return typeof payloadModel === "string" && isAffectedQualifiedModel(payloadModel.trim().toLowerCase());
}

function isAffectedQualifiedModel(modelRef: string): boolean {
	const slash = modelRef.indexOf("/");
	if (slash <= 0 || slash === modelRef.length - 1) return false;
	return isAffectedProviderModel(modelRef.slice(0, slash), modelRef.slice(slash + 1));
}

function isAffectedProviderModel(provider: string, modelId: string | undefined): boolean {
	if (provider === OPENAI_CODEX_PROVIDER) return true;
	return provider === OPENAI_PROVIDER && modelId !== undefined && isGpt56OrNewer(modelId);
}

function isGpt56OrNewer(modelId: string): boolean {
	const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/u.exec(modelId);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2] ?? 0);
	return major > 5 || (major === 5 && minor >= 6);
}

function modelIdentity(model: unknown): { provider?: string; id?: string } {
	if (typeof model === "string") return { id: model.trim().toLowerCase() };
	if (!isRecord(model)) return {};

	const provider = firstString(model.provider, model.providerId, model.providerID);
	const id = firstString(model.id, model.modelId, model.modelID, model.model);
	return {
		provider: provider?.toLowerCase(),
		id: id?.toLowerCase(),
	};
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
