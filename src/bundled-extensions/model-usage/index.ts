import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	MODEL_USAGE_RESPONSE_HEADERS_EVENT,
	pickAnthropicRateLimitHeaders,
} from "../../app/model/anthropic-header-usage.js";

/**
 * Shared identity of attributable outstanding provider requests in this
 * session process, captured from each request payload itself.
 */
type PendingProviderRequest = {
	readonly provider: string;
	readonly modelId: string;
	readonly sessionId: string;
};

function requestIdentityFromPayload(
	payload: unknown,
	ctx: { model?: { provider: string } | undefined; sessionManager: { getSessionId(): string } },
): PendingProviderRequest | undefined {
	const model = ctx.model;
	// Without a session model the provider of the request is unknowable, so the
	// response can never be attributed safely.
	if (!model) return undefined;
	const modelId = payload !== null && typeof payload === "object" && !Array.isArray(payload)
		&& typeof (payload as { model?: unknown }).model === "string"
		&& (payload as { model: string }).model.length > 0
		? (payload as { model: string }).model
		: undefined;
	// The request payload is the only request-scoped identity extensions can
	// observe (the SDK drops the request model when re-emitting response
	// events); without it the response cannot be attributed.
	if (!modelId) return undefined;
	return { provider: model.provider, modelId, sessionId: ctx.sessionManager.getSessionId() };
}

/**
 * Forwards Anthropic Messages rate-limit response headers to the host UI.
 *
 * The SDK exposes provider response headers only through the extension event
 * `after_provider_response`, so this bridge keeps usage capture inside the
 * session process and relays the already-received headers over the extension
 * event bus. It never issues network requests of its own: the TUI derives
 * API-key usage purely from responses the session already produced, while
 * OAuth (`sk-ant-oat`) sessions keep using the `api/oauth/usage` endpoint —
 * the host drops header samples for them. Speculative
 * `anthropic-ratelimit-unified-*` subscription headers are never forwarded.
 *
 * Attribution invariant (fail-closed): `after_provider_response` carries only
 * status and headers — no request model identity — and its `ctx.model` /
 * `ctx.sessionManager` are LIVE views that can already point at a model or
 * session selected AFTER the request was sent (model switch mid-flight,
 * session replacement). Attributing a response through the response-time ctx
 * would therefore misattribute the previous model's usage. Instead, the
 * request's own identity is captured from `before_provider_response`'s
 * sibling `before_provider_request` (the payload's `model` field, which is
 * exactly the model id the provider call uses), and a response is forwarded
 * only when it can be matched to that captured request and the session id is
 * unchanged. Responses without an attributable request — including requests
 * that started before this extension loaded, non-string payload models, and
 * non-Anthropic providers — are dropped. No identity is ever synthesized.
 *
 * The payload carries its own session/model identity so the host can discard
 * samples from stale or background sessions; nothing is attributed globally.
 */
export default function modelUsageTelemetry(pi: ExtensionAPI): void {
	let pendingRequest: PendingProviderRequest | undefined;
	let outstandingRequests = 0;
	let ambiguousRequests = false;
	pi.on("agent_end", () => {
		// A provider failure may have no HTTP response callback. Discard the
		// unmatched identity before another user turn can begin.
		pendingRequest = undefined;
		outstandingRequests = 0;
		ambiguousRequests = false;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const request = requestIdentityFromPayload(event.payload, ctx);
		// A warmer may overlap the main call. Attribute either response only
		// when all outstanding requests share one request-scoped identity.
		if (outstandingRequests === 0) {
			pendingRequest = request;
			ambiguousRequests = !request;
		} else if (!request || !pendingRequest || request.provider !== pendingRequest.provider
			|| request.modelId !== pendingRequest.modelId || request.sessionId !== pendingRequest.sessionId) {
			ambiguousRequests = true;
		}
		outstandingRequests++;
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (outstandingRequests === 0) return;
		outstandingRequests--;
		const request = pendingRequest;
		const attributable = !ambiguousRequests && request?.provider.toLowerCase() === "anthropic";
		if (outstandingRequests === 0) {
			pendingRequest = undefined;
			ambiguousRequests = false;
		}
		if (!attributable || !request) return;

		const headers = pickAnthropicRateLimitHeaders(event.headers);
		if (Object.keys(headers).length === 0) return;

		// The session identity must be unchanged since the request: a replaced
		// session must not inherit the previous session's header samples.
		if (ctx.sessionManager.getSessionId() !== request.sessionId) return;

		pi.events.emit(MODEL_USAGE_RESPONSE_HEADERS_EVENT, {
			version: 1,
			sessionId: request.sessionId,
			modelRef: `${request.provider}/${request.modelId}`,
			status: event.status,
			headers,
		});
	});
}
