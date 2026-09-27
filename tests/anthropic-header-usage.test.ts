import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { formatCompactProgressBar } from "../src/context-progress-bar.js";
import modelUsageTelemetry from "../src/bundled-extensions/model-usage/index.js";
import {
	MODEL_USAGE_RESPONSE_HEADERS_EVENT,
	anthropicUsageStatusFromResponseHeaders,
	parseModelUsageResponseHeadersPayload,
	pickAnthropicRateLimitHeaders,
} from "../src/app/model/anthropic-header-usage.js";
import {
	formatModelUsageStatusLabel,
	modelUsageRemainingPercent,
	resolveAnthropicAuthKind,
} from "../src/app/model/model-usage-status.js";

const NOW = Date.parse("2025-07-01T12:00:00.000Z");

describe("anthropic response-header usage", () => {
	it("reports the single most limiting bucket with its own reset and unknown window duration", () => {
		const status = anthropicUsageStatusFromResponseHeaders({
			"anthropic-ratelimit-requests-limit": "1000",
			"anthropic-ratelimit-requests-remaining": "400",
			"anthropic-ratelimit-requests-reset": "2025-07-01T12:00:30Z",
			"anthropic-ratelimit-tokens-limit": "80000",
			"anthropic-ratelimit-tokens-remaining": "20000",
			"anthropic-ratelimit-tokens-reset": "2025-07-01T12:00:41Z",
			"anthropic-ratelimit-input-tokens-limit": "60000",
			"anthropic-ratelimit-input-tokens-remaining": "30000",
			"anthropic-ratelimit-input-tokens-reset": "2025-07-01T12:00:35Z",
			"anthropic-ratelimit-output-tokens-limit": "20000",
			"anthropic-ratelimit-output-tokens-remaining": "16000",
			"anthropic-ratelimit-output-tokens-reset": "2025-07-01T12:00:44Z",
		}, "anthropic/claude-sonnet-4-6", NOW);

		assert.ok(status);
		assert.equal(status.provider, "anthropic");
		assert.equal(status.modelKey, "anthropic/claude-sonnet-4-6");
		assert.equal(status.updatedAt, NOW);
		// Exactly one window: tokens (25%) is more limiting than input tokens
		// (50%), output tokens (80%), and requests (40%).
		assert.deepEqual(status.rateWindows, [
			{
				remainingPercent: 25,
				resetAt: NOW + 41_000,
				windowSeconds: 41,
				hasKnownWindowDuration: false,
				label: "TPM",
			},
		]);
		assert.equal(
			formatModelUsageStatusLabel(status, NOW),
			`TPM 25% ${formatCompactProgressBar(25)} 1m`,
		);
		assert.equal(modelUsageRemainingPercent(status), 25);
	});

	it("keeps the split input/output token buckets and standardized aliases in the comparison", () => {
		const status = anthropicUsageStatusFromResponseHeaders({
			"x-ratelimit-limit-requests": "50",
			"x-ratelimit-remaining-requests": "45",
			"x-ratelimit-reset-requests": "2025-07-01T12:00:20Z",
			"x-ratelimit-limit-input-tokens": "1000",
			"x-ratelimit-remaining-input-tokens": "100",
			"x-ratelimit-reset-input-tokens": "2025-07-01T12:00:55Z",
			"anthropic-ratelimit-output-tokens-limit": "500",
			"anthropic-ratelimit-output-tokens-remaining": "250",
			"anthropic-ratelimit-output-tokens-reset": "2025-07-01T12:00:10Z",
		}, "anthropic/claude-haiku-4-5", NOW);

		assert.ok(status);
		assert.deepEqual(status.rateWindows?.map((window) => [window.label, window.remainingPercent, window.resetAt]), [
			["ITPM", 10, NOW + 55_000],
		]);
	});

	it("compares exact ratios and breaks ties deterministically by family order", () => {
		// 5/10 and 50/100 tie exactly; the earlier family (requests) wins.
		const tie = anthropicUsageStatusFromResponseHeaders({
			"anthropic-ratelimit-requests-limit": "10",
			"anthropic-ratelimit-requests-remaining": "5",
			"anthropic-ratelimit-requests-reset": "2025-07-01T12:00:30Z",
			"anthropic-ratelimit-tokens-limit": "100",
			"anthropic-ratelimit-tokens-remaining": "50",
			"anthropic-ratelimit-tokens-reset": "2025-07-01T12:00:40Z",
		}, "anthropic/claude-sonnet-4-6", NOW);
		assert.deepEqual(tie?.rateWindows?.map((window) => window.label), ["RPM"]);

		// 6/16 = 37.5% is more limiting than 38/100 = 38% despite the rounded
		// percentages both displaying close values.
		const exact = anthropicUsageStatusFromResponseHeaders({
			"anthropic-ratelimit-requests-limit": "100",
			"anthropic-ratelimit-requests-remaining": "38",
			"anthropic-ratelimit-requests-reset": "2025-07-01T12:00:30Z",
			"anthropic-ratelimit-tokens-limit": "16",
			"anthropic-ratelimit-tokens-remaining": "6",
			"anthropic-ratelimit-tokens-reset": "2025-07-01T12:00:40Z",
		}, "anthropic/claude-sonnet-4-6", NOW);
		assert.deepEqual(exact?.rateWindows?.map((window) => [window.label, window.remainingPercent]), [["TPM", 38]]);
	});

	it("produces no status when no bucket has a valid reset header", () => {
		// Every bucket lacks a reset instant: nothing complete can be chosen,
		// and fabricating a snapshot without a reset would imply "resets now".
		assert.equal(anthropicUsageStatusFromResponseHeaders({
			"anthropic-ratelimit-requests-limit": "1000",
			"anthropic-ratelimit-requests-remaining": "500",
			"anthropic-ratelimit-tokens-limit": "80000",
			"anthropic-ratelimit-tokens-remaining": "16000",
		}, "anthropic/claude-sonnet-4-6", NOW), undefined);

		// An unparseable reset is just as incomplete as a missing one.
		assert.equal(anthropicUsageStatusFromResponseHeaders({
			"anthropic-ratelimit-requests-limit": "1000",
			"anthropic-ratelimit-requests-remaining": "500",
			"anthropic-ratelimit-requests-reset": "whenever-anthropic-feels-like-it",
		}, "anthropic/claude-sonnet-4-6", NOW), undefined);
		for (const reset of ["45", "30s", "2025-07-01", "2025-07-01T12:00:30"]) {
			assert.equal(anthropicUsageStatusFromResponseHeaders({
				"anthropic-ratelimit-requests-limit": "1000",
				"anthropic-ratelimit-requests-remaining": "500",
				"anthropic-ratelimit-requests-reset": reset,
			}, "anthropic/claude-sonnet-4-6", NOW), undefined);
		}
	});

	it("never lets an incomplete bucket displace a complete one", () => {
		// TPM at 20% without a reset is more limiting than RPM at 40% with a
		// valid reset, but only complete buckets are selectable.
		const status = anthropicUsageStatusFromResponseHeaders({
			"anthropic-ratelimit-requests-limit": "1000",
			"anthropic-ratelimit-requests-remaining": "400",
			"anthropic-ratelimit-requests-reset": "2025-07-01T12:00:30Z",
			"anthropic-ratelimit-tokens-limit": "80000",
			"anthropic-ratelimit-tokens-remaining": "16000",
		}, "anthropic/claude-sonnet-4-6", NOW);

		assert.ok(status);
		assert.deepEqual(status.rateWindows?.map((window) => [window.label, window.remainingPercent, window.resetAt]), [
			["RPM", 40, NOW + 30_000],
		]);
		assert.equal(
			formatModelUsageStatusLabel(status, NOW),
			`RPM 40% ${formatCompactProgressBar(40)} 1m`,
		);

		// An unparseable reset must not displace a complete bucket either.
		const invalid = anthropicUsageStatusFromResponseHeaders({
			"anthropic-ratelimit-requests-limit": "1000",
			"anthropic-ratelimit-requests-remaining": "400",
			"anthropic-ratelimit-requests-reset": "2025-07-01T12:00:30Z",
			"anthropic-ratelimit-tokens-limit": "80000",
			"anthropic-ratelimit-tokens-remaining": "16000",
			"anthropic-ratelimit-tokens-reset": "soon-ish",
		}, "anthropic/claude-sonnet-4-6", NOW);
		assert.deepEqual(invalid?.rateWindows?.map((window) => window.label), ["RPM"]);
	});

	it("ignores responses without usable rate-limit headers", () => {
		assert.equal(anthropicUsageStatusFromResponseHeaders({}, "anthropic/claude-opus-4-6", NOW), undefined);
		assert.equal(
			anthropicUsageStatusFromResponseHeaders({ "content-type": "application/json" }, "anthropic/claude-opus-4-6", NOW),
			undefined,
		);
		assert.equal(
			anthropicUsageStatusFromResponseHeaders({ "anthropic-ratelimit-requests-limit": "0", "anthropic-ratelimit-requests-remaining": "0" }, "anthropic/claude-opus-4-6", NOW),
			undefined,
		);
		assert.equal(
			anthropicUsageStatusFromResponseHeaders({ "anthropic-ratelimit-requests-limit": "many", "anthropic-ratelimit-requests-remaining": "1" }, "anthropic/claude-opus-4-6", NOW),
			undefined,
		);
		// A family missing its remaining count cannot contribute a percentage;
		// other families still can.
		const partial = anthropicUsageStatusFromResponseHeaders({
			"anthropic-ratelimit-requests-limit": "4",
			"anthropic-ratelimit-requests-remaining": "0",
			"anthropic-ratelimit-requests-reset": "2025-07-01T12:00:45Z",
			"anthropic-ratelimit-tokens-limit": "80000",
		}, "anthropic/claude-sonnet-4-6", NOW);
		assert.deepEqual(partial?.rateWindows?.map((window) => [window.label, window.remainingPercent, window.resetAt]), [
			["RPM", 0, NOW + 45_000],
		]);
	});

	it("ignores the speculative unified subscription headers", () => {
		assert.equal(
			anthropicUsageStatusFromResponseHeaders({
				"anthropic-ratelimit-unified-quota": "37.6",
				"anthropic-ratelimit-unified-status": "ok",
				"anthropic-ratelimit-unified-reset-at": "2025-07-01T15:00:00Z",
			}, "anthropic/claude-opus-4-6", NOW),
			undefined,
		);

		// Unified headers never override or join the API-key buckets.
		const status = anthropicUsageStatusFromResponseHeaders({
			"anthropic-ratelimit-unified-quota": "99",
			"anthropic-ratelimit-requests-limit": "10",
			"anthropic-ratelimit-requests-remaining": "9",
			"anthropic-ratelimit-requests-reset": "2025-07-01T12:00:30Z",
		}, "anthropic/claude-opus-4-6", NOW);
		assert.deepEqual(status?.rateWindows?.map((window) => [window.label, window.remainingPercent]), [["RPM", 90]]);
	});

	it("clamps a past reset timestamp to now", () => {
		const status = anthropicUsageStatusFromResponseHeaders({
			"anthropic-ratelimit-requests-limit": "10",
			"anthropic-ratelimit-requests-remaining": "10",
			"anthropic-ratelimit-requests-reset": "2025-06-01T00:00:00Z",
		}, "anthropic/claude-sonnet-4-6", NOW);

		assert.ok(status);
		assert.equal(status.rateWindows?.[0]?.resetAt, NOW);
	});

	it("filters forwarded headers to the Anthropic rate-limit subset", () => {
		assert.deepEqual(pickAnthropicRateLimitHeaders({
			"content-type": "application/json",
			"anthropic-ratelimit-requests-limit": "10",
			"anthropic-ratelimit-unified-quota": "12",
			"X-RateLimit-Limit-Requests": "1000",
			"request-id": "req_123",
		}), {
			"anthropic-ratelimit-requests-limit": "10",
			"x-ratelimit-limit-requests": "1000",
		});
		assert.deepEqual(pickAnthropicRateLimitHeaders(undefined), {});
	});

	it("validates the extension-bus payload shape", () => {
		const valid = {
			version: 1,
			sessionId: "session-1",
			modelRef: "anthropic/claude-opus-4-6",
			status: 200,
			headers: { "Anthropic-Ratelimit-Requests-Limit": "10" },
		};
		assert.deepEqual(parseModelUsageResponseHeadersPayload(valid), {
			version: 1,
			sessionId: "session-1",
			modelRef: "anthropic/claude-opus-4-6",
			status: 200,
			headers: { "anthropic-ratelimit-requests-limit": "10" },
		});

		assert.equal(parseModelUsageResponseHeadersPayload(undefined), undefined);
		assert.equal(parseModelUsageResponseHeadersPayload("nope"), undefined);
		assert.equal(parseModelUsageResponseHeadersPayload({ ...valid, version: 2 }), undefined);
		assert.equal(parseModelUsageResponseHeadersPayload({ ...valid, sessionId: "" }), undefined);
		assert.equal(parseModelUsageResponseHeadersPayload({ ...valid, modelRef: "" }), undefined);
		assert.equal(parseModelUsageResponseHeadersPayload({ ...valid, status: "200" }), undefined);
		assert.equal(parseModelUsageResponseHeadersPayload({ ...valid, headers: {} }), undefined);
		// Non-string header values are dropped rather than rejected wholesale.
		assert.deepEqual(
			parseModelUsageResponseHeadersPayload({ ...valid, headers: { ok: "1", bad: 2 } })?.headers,
			{ ok: "1" },
		);
	});

	it("forwards observed provider headers onto the extension event bus", async () => {
		const harness = extensionHarness();
		const anthropicCtx = (modelId: string, sessionId = "session-42") => ({
			model: { provider: "anthropic", id: modelId },
			sessionManager: { getSessionId: () => sessionId },
		});

		await harness.beforeRequest({ model: "claude-sonnet-4-6", max_tokens: 1024 }, anthropicCtx("claude-sonnet-4-6"));
		await harness.afterResponse({
			status: 200,
			headers: {
				"content-type": "application/json",
				"anthropic-ratelimit-requests-limit": "1000",
				"anthropic-ratelimit-requests-remaining": "900",
				"anthropic-ratelimit-requests-reset": "2025-07-01T12:00:30Z",
			},
		}, anthropicCtx("claude-sonnet-4-6"));

		// No rate-limit headers: nothing is forwarded.
		await harness.beforeRequest({ model: "claude-sonnet-4-6" }, anthropicCtx("claude-sonnet-4-6"));
		await harness.afterResponse({ status: 200, headers: { "content-type": "application/json" } }, anthropicCtx("claude-sonnet-4-6"));

		// No model on the request context: the provider is unknowable, so the
		// response fails closed and nothing is forwarded.
		await harness.beforeRequest({ model: "claude-sonnet-4-6" }, {
			model: undefined,
			sessionManager: { getSessionId: () => "session-42" },
		});
		await harness.afterResponse({ status: 429, headers: { "anthropic-ratelimit-requests-limit": "10" } }, anthropicCtx("claude-sonnet-4-6"));

		// Other providers carry x-ratelimit-* headers too, but those describe
		// different quotas and must not be attributed to Anthropic usage.
		await harness.beforeRequest({ model: "gpt-5.5" }, {
			model: { provider: "openai-codex", id: "gpt-5.5" },
			sessionManager: { getSessionId: () => "session-42" },
		});
		await harness.afterResponse({ status: 200, headers: { "x-ratelimit-remaining-requests": "9" } }, {
			model: { provider: "openai-codex", id: "gpt-5.5" },
			sessionManager: { getSessionId: () => "session-42" },
		});

		assert.deepEqual(harness.emitted, [{
			channel: MODEL_USAGE_RESPONSE_HEADERS_EVENT,
			data: {
				version: 1,
				sessionId: "session-42",
				modelRef: "anthropic/claude-sonnet-4-6",
				status: 200,
				headers: {
					"anthropic-ratelimit-requests-limit": "1000",
					"anthropic-ratelimit-requests-remaining": "900",
					"anthropic-ratelimit-requests-reset": "2025-07-01T12:00:30Z",
				},
			},
		}]);
	});

	it("attributes a response to the model of the request that earned it, not the live ctx", async () => {
		const harness = extensionHarness();

		// Deterministic race: the request is sent with Sonnet, then the user
		// switches the session model while the response is still in flight. The
		// live ctx at response time already reports Opus, but the headers were
		// earned by the Sonnet request and must be attributed to it — never to
		// the model selected after the request.
		await harness.beforeRequest({ model: "claude-sonnet-4-6" }, {
			model: { provider: "anthropic", id: "claude-sonnet-4-6" },
			sessionManager: { getSessionId: () => "session-42" },
		});
		await harness.afterResponse({ status: 200, headers: { "anthropic-ratelimit-requests-limit": "10" } }, {
			model: { provider: "anthropic", id: "claude-opus-4-6" },
			sessionManager: { getSessionId: () => "session-42" },
		});

		assert.deepEqual(harness.emitted.map((entry) => entry.data), [{
			version: 1,
			sessionId: "session-42",
			modelRef: "anthropic/claude-sonnet-4-6",
			status: 200,
			headers: { "anthropic-ratelimit-requests-limit": "10" },
		}]);
	});

	it("fails closed when a response cannot be attributed to a request", async () => {
		// Response without any preceding observed request (e.g. the request
		// started before the extension loaded): no identity is invented.
		const unpaired = extensionHarness();
		await unpaired.afterResponse(
			{ status: 200, headers: { "anthropic-ratelimit-requests-limit": "10" } },
			{ model: { provider: "anthropic", id: "claude-sonnet-4-6" }, sessionManager: { getSessionId: () => "session-42" } },
		);
		assert.deepEqual(unpaired.emitted, []);

		// Request payload without a usable model string: the response cannot be
		// attributed, so it is dropped rather than guessed from the live ctx.
		const anonymous = extensionHarness();
		await anonymous.beforeRequest({ max_tokens: 1024 }, {
			model: { provider: "anthropic", id: "claude-sonnet-4-6" },
			sessionManager: { getSessionId: () => "session-42" },
		});
		await anonymous.afterResponse(
			{ status: 200, headers: { "anthropic-ratelimit-requests-limit": "10" } },
			{ model: { provider: "anthropic", id: "claude-sonnet-4-6" }, sessionManager: { getSessionId: () => "session-42" } },
		);
		assert.deepEqual(anonymous.emitted, []);

		// Session identity changed between request and response (session
		// replacement in the same runtime): the new session must not inherit
		// the previous session's sample.
		const replaced = extensionHarness();
		await replaced.beforeRequest({ model: "claude-sonnet-4-6" }, {
			model: { provider: "anthropic", id: "claude-sonnet-4-6" },
			sessionManager: { getSessionId: () => "session-old" },
		});
		await replaced.afterResponse(
			{ status: 200, headers: { "anthropic-ratelimit-requests-limit": "10" } },
			{ model: { provider: "anthropic", id: "claude-sonnet-4-6" }, sessionManager: { getSessionId: () => "session-new" } },
		);
		assert.deepEqual(replaced.emitted, []);
	});

	it("keeps attributing interleaved same-model responses (cache warming)", async () => {
		const harness = extensionHarness();
		const ctx = {
			model: { provider: "anthropic", id: "claude-sonnet-4-6" },
			sessionManager: { getSessionId: () => "session-42" },
		};
		const headers = { "anthropic-ratelimit-requests-limit": "10" };

		// Cache warming reuses the model of the request that triggered it, so
		// the main call and the warm call can be in flight at once. Both
		// responses belong to the same request-scoped model identity.
		await harness.beforeRequest({ model: "claude-sonnet-4-6" }, ctx);
		await harness.beforeRequest({ model: "claude-sonnet-4-6" }, ctx);
		await harness.afterResponse({ status: 200, headers }, ctx);
		await harness.afterResponse({ status: 200, headers }, ctx);

		assert.equal(harness.emitted.length, 2);
		assert.deepEqual(new Set(harness.emitted.map((entry) => (entry.data as { modelRef: string }).modelRef)), new Set(["anthropic/claude-sonnet-4-6"]));
		await harness.afterResponse({ status: 200, headers }, ctx);
		assert.equal(harness.emitted.length, 2, "a response without a matching request must not reuse stale identity");
	});

	it("fails closed if overlapping requests use different models", async () => {
		const harness = extensionHarness();
		const ctx = (id: string) => ({
			model: { provider: "anthropic", id },
			sessionManager: { getSessionId: () => "session-42" },
		});
		const headers = { "anthropic-ratelimit-requests-limit": "10" };
		await harness.beforeRequest({ model: "claude-sonnet-4-6" }, ctx("claude-sonnet-4-6"));
		await harness.beforeRequest({ model: "claude-opus-4-6" }, ctx("claude-opus-4-6"));
		await harness.afterResponse({ status: 200, headers }, ctx("claude-opus-4-6"));
		await harness.afterResponse({ status: 200, headers }, ctx("claude-opus-4-6"));
		assert.deepEqual(harness.emitted, []);
	});

	it("discards an unmatched request after a failed agent turn", async () => {
		const harness = extensionHarness();
		const ctx = {
			model: { provider: "anthropic", id: "claude-sonnet-4-6" },
			sessionManager: { getSessionId: () => "session-42" },
		};
		const headers = { "anthropic-ratelimit-requests-limit": "10" };
		await harness.beforeRequest({ model: "claude-sonnet-4-6" }, ctx);
		await harness.endTurn(); // Provider failed before it produced a response.
		await harness.afterResponse({ status: 200, headers }, ctx);
		assert.equal(harness.emitted.length, 0);
		await harness.beforeRequest({ model: "claude-sonnet-4-6" }, ctx);
		await harness.afterResponse({ status: 200, headers }, ctx);
		assert.equal(harness.emitted.length, 1);
	});

	it("classifies Anthropic auth without leaking credentials or contacting the usage endpoint", async () => {
		await withAnthropicAuthTestEnv(async () => {
			await withAnthropicAuth({ anthropic: { type: "oauth", access: "sk-ant-oat-abc", refresh: "rt" } }, async () => {
				assert.equal(await resolveAnthropicAuthKind(), "oauth");
			});

			await withAnthropicAuth({ anthropic: { type: "api_key", key: "sk-ant-api03-xyz" } }, async () => {
				assert.equal(await resolveAnthropicAuthKind(), "api-key");
			});

			// `claude setup-token` subscription tokens are stored as plain keys
			// but still use the oauth/usage endpoint.
			await withAnthropicAuth({ anthropic: { type: "api_key", key: "sk-ant-oat-setup-token" } }, async () => {
				assert.equal(await resolveAnthropicAuthKind(), "oauth");
			});

			await withAnthropicAuth({}, async () => {
				assert.equal(await resolveAnthropicAuthKind(), "api-key");
			});

			process.env.ANTHROPIC_API_KEY = "sk-ant-api03-env";
			try {
				await withAnthropicAuth({}, async () => {
					assert.equal(await resolveAnthropicAuthKind(), "api-key");
				});
			} finally {
				delete process.env.ANTHROPIC_API_KEY;
			}
		});
	});
});

const ANTHROPIC_AUTH_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"] as const;

type ExtensionEventHarness = {
	readonly emitted: Array<{ channel: string; data: unknown }>;
	beforeRequest(payload: unknown, ctx: unknown): Promise<void>;
	afterResponse(event: { status: number; headers: Record<string, string> }, ctx: unknown): Promise<void>;
	endTurn(): Promise<void>;
};

/** Deterministic driver for the extension's provider request/response pair. */
function extensionHarness(): ExtensionEventHarness {
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const handlers = new Map<string, (event: never, ctx: never) => Promise<void> | void>();
	modelUsageTelemetry({
		on: (name: string, handler: (event: never, ctx: never) => Promise<void> | void) => { handlers.set(name, handler); },
		events: {
			emit: (channel: string, data: unknown) => { emitted.push({ channel, data }); },
			on: () => () => {},
		},
	} as never);

	const invoke = (name: string): ((event: never, ctx: never) => Promise<void> | void) => {
		const handler = handlers.get(name);
		assert.ok(handler, `Expected the extension to register ${name}`);
		return handler;
	};

	return {
		emitted,
		beforeRequest: (payload, ctx) => Promise.resolve(invoke("before_provider_request")({ type: "before_provider_request", payload } as never, ctx as never)),
		afterResponse: (event, ctx) => Promise.resolve(invoke("after_provider_response")({ type: "after_provider_response", ...event } as never, ctx as never)),
		endTurn: () => Promise.resolve(invoke("agent_end")({ type: "agent_end" } as never, {} as never)),
	};
}

async function withAnthropicAuthTestEnv(run: () => Promise<void>): Promise<void> {
	const previous = ANTHROPIC_AUTH_ENV_VARS.map((name) => [name, process.env[name]] as const);
	for (const name of ANTHROPIC_AUTH_ENV_VARS) delete process.env[name];
	try {
		await run();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

async function withAnthropicAuth(auth: unknown, run: () => Promise<void>): Promise<void> {
	const previousNodeEnv = process.env.NODE_ENV;
	const previousAuthPath = process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
	const agentDir = mkdtempSync(join(tmpdir(), "pix-anthropic-auth-"));
	const authPath = join(agentDir, "auth.json");
	writeFileSync(authPath, JSON.stringify(auth), "utf8");
	process.env.NODE_ENV = "test";
	process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH = authPath;
	try {
		await run();
	} finally {
		if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = previousNodeEnv;
		if (previousAuthPath === undefined) delete process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
		else process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH = previousAuthPath;
		rmSync(agentDir, { recursive: true, force: true });
	}
}
