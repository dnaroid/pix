import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { AppModelUsageController, type AppModelUsageQuery } from "../src/app/model/model-usage-controller.js";
import { MODEL_USAGE_POLL_INTERVAL_MS } from "../src/app/constants.js";
import type { AnthropicAuthKind, ModelUsageDescriptor, ModelUsageStatus } from "../src/app/model/model-usage-status.js";
import type { SessionModel } from "../src/app/types.js";

const FIXED_NOW = Date.parse("2025-07-01T12:00:00.000Z");

describe("model usage controller", () => {
	it("polls Claude Code quota independently of Pi Anthropic API-key classification", async () => {
		const activeSession = sessionWithModel("pi-claude-code-provider", "claude-opus-5-5");
		let queries = 0;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			anthropicAuthKind: async () => { throw new Error("Pi Anthropic auth is unrelated"); },
			render: () => {},
		}, async (descriptor) => {
			assert.equal(descriptor.kind, "claude-code");
			queries++;
			return usageStatus(descriptor, 72);
		});

		controller.observeSession(activeSession);
		await settlePromises();
		assert.match(controller.statusLabel(), /^72%/u);
		assert.equal(queries, 1);
		const refresh = controller.refreshNow();
		assert.equal(refresh.kind, "started");
		if (refresh.kind === "started") assert.equal(await refresh.promise, "refreshed");
		assert.equal(queries, 2);
	});

	it("retries Claude Code quota early while its local credential is missing, then disarms on success", async () => {
		const claudeSession = sessionWithModel("pi-claude-code-provider", "claude-opus-5-5");
		const otherSession = sessionWithModel("openai-codex", "gpt-5.5");
		let activeSession: AgentSession = claudeSession;
		const claudeQueries: number[] = [];
		let credentialAvailable = false;
		let quotaAvailable = false;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			render: () => {},
		}, async (descriptor) => {
			if (descriptor.kind !== "claude-code") return usageStatus(descriptor, 50);
			claudeQueries.push(Date.now());
			return quotaAvailable ? usageStatus(descriptor, 72) : undefined;
		}, async () => credentialAvailable);

		const realNow = Date.now;
		let nowMs = FIXED_NOW;
		Date.now = () => nowMs;
		try {
			controller.observeSession(claudeSession);
			await settlePromises();
			await settlePromises();
			assert.deepEqual(claudeQueries, [FIXED_NOW]);

			// Toggling away and back re-attempts the active route through the
			// interval gate: 20s after the first attempt is still too early.
			nowMs += 20_000;
			activeSession = otherSession;
			controller.observeSession(otherSession);
			await settlePromises();
			activeSession = claudeSession;
			controller.observeSession(claudeSession);
			await settlePromises();
			assert.deepEqual(claudeQueries, [FIXED_NOW]);

			// 31s after the unavailable attempt the accelerated credential retry
			// fires without waiting for the five-minute poll interval.
			nowMs += 11_000;
			activeSession = otherSession;
			controller.observeSession(otherSession);
			activeSession = claudeSession;
			controller.observeSession(claudeSession);
			await settlePromises();
			await settlePromises();
			assert.deepEqual(claudeQueries, [FIXED_NOW, FIXED_NOW + 31_000]);
			assert.equal(controller.statusLabel(), "");

			// The fast cadence never drops below the credential retry interval.
			nowMs += 10_000;
			activeSession = otherSession;
			controller.observeSession(otherSession);
			activeSession = claudeSession;
			controller.observeSession(claudeSession);
			await settlePromises();
			assert.deepEqual(claudeQueries, [FIXED_NOW, FIXED_NOW + 31_000]);

			// Claude Code refreshed its login: the next accelerated retry now
			// succeeds, disarms the fast cadence, and shows fresh quota.
			credentialAvailable = true;
			quotaAvailable = true;
			nowMs += 21_000;
			activeSession = otherSession;
			controller.observeSession(otherSession);
			activeSession = claudeSession;
			controller.observeSession(claudeSession);
			await settlePromises();
			await settlePromises();
			assert.deepEqual(claudeQueries, [FIXED_NOW, FIXED_NOW + 31_000, FIXED_NOW + 62_000]);
			assert.match(controller.statusLabel(), /^72%/u);

			// Disarmed: a later switch inside the poll interval issues no query.
			nowMs += 33_000;
			activeSession = otherSession;
			controller.observeSession(otherSession);
			activeSession = claudeSession;
			controller.observeSession(claudeSession);
			await settlePromises();
			assert.deepEqual(claudeQueries, [FIXED_NOW, FIXED_NOW + 31_000, FIXED_NOW + 62_000]);
			assert.match(controller.statusLabel(), /^72%/u);
		} finally {
			Date.now = realNow;
		}
	});

	it("keeps the regular cadence when a Claude Code credential exists but the endpoint returns no quota", async () => {
		const claudeSession = sessionWithModel("pi-claude-code-provider", "claude-opus-5-5");
		const otherSession = sessionWithModel("openai-codex", "gpt-5.5");
		let activeSession: AgentSession = claudeSession;
		const claudeQueries: number[] = [];
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			render: () => {},
		}, async (descriptor) => {
			if (descriptor.kind !== "claude-code") return usageStatus(descriptor, 50);
			claudeQueries.push(Date.now());
			return undefined;
		}, async () => true);

		const realNow = Date.now;
		let nowMs = FIXED_NOW;
		Date.now = () => nowMs;
		try {
			controller.observeSession(claudeSession);
			await settlePromises();
			await settlePromises();
			assert.deepEqual(claudeQueries, [FIXED_NOW]);

			// A present credential means the unavailability came from the usage
			// endpoint response; faster retries would add provider network load.
			nowMs += 90_000;
			activeSession = otherSession;
			controller.observeSession(otherSession);
			activeSession = claudeSession;
			controller.observeSession(claudeSession);
			await settlePromises();
			await settlePromises();
			assert.deepEqual(claudeQueries, [FIXED_NOW]);
		} finally {
			Date.now = realNow;
		}
	});

	it("keeps cached usage per provider/model when switching sessions", async () => {
		let activeSession = sessionWithModel("openai-codex", "gpt-5.5");
		let renderCount = 0;
		const queriedModelKeys: string[] = [];
		const query: AppModelUsageQuery = async (descriptor) => {
			queriedModelKeys.push(descriptor.modelKey);
			return usageStatus(descriptor, descriptor.modelKey.endsWith("gpt-5.5") ? 80 : 35);
		};
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			render: () => {
				renderCount++;
			},
		}, query);

		controller.observeSession(activeSession);
		await settlePromises();
		assert.match(controller.statusLabel(), /^80%/u);

		activeSession = sessionWithModel("openai-codex", "gpt-5-mini");
		controller.observeSession(activeSession);
		await settlePromises();
		assert.match(controller.statusLabel(), /^35%/u);

		activeSession = sessionWithModel("openai-codex", "gpt-5.5");
		controller.observeSession(activeSession);

		assert.match(controller.statusLabel(), /^80%/u);
		assert.deepEqual(queriedModelKeys, ["openai-codex/gpt-5.5", "openai-codex/gpt-5-mini"]);
		assert.ok(renderCount >= 3);
	});

	it("force refreshes the active model usage on demand", async () => {
		const activeSession = sessionWithModel("openai-codex", "gpt-5.5");
		let remainingPercent = 80;
		let queryCount = 0;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			render: () => {},
		}, async (descriptor) => {
			queryCount++;
			return usageStatus(descriptor, remainingPercent);
		});

		controller.observeSession(activeSession);
		await settlePromises();
		assert.match(controller.statusLabel(), /^80%/u);

		remainingPercent = 42;
		const refresh = controller.refreshNow();
		assert.equal(refresh.kind, "started");
		if (refresh.kind !== "started") throw new Error("Expected started refresh");

		assert.equal(await refresh.promise, "refreshed");
		assert.match(controller.statusLabel(), /^42%/u);
		assert.equal(queryCount, 2);
	});

	it("refreshes Antigravity usage when the thinking tier changes", async () => {
		let activeSession = sessionWithModel("antigravity", "antigravity-gemini-3.8-flash", "medium");
		const candidates: string[][] = [];
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			render: () => {},
		}, async (descriptor) => {
			if (descriptor.kind !== "google-antigravity") throw new Error("Expected Antigravity descriptor");
			candidates.push([...(descriptor.quotaModelCandidates ?? [descriptor.quotaModelKey])]);
			return usageStatus(descriptor, 80);
		});

		controller.observeSession(activeSession);
		await settlePromises();
		activeSession = sessionWithModel("antigravity", "antigravity-gemini-3.8-flash", "xhigh");
		controller.observeSession(activeSession);
		await settlePromises();

		assert.deepEqual(candidates, [
			["gemini-3.8-flash", "gemini-3.8-flash-medium"],
			["gemini-3.8-flash", "gemini-3.8-flash-high"],
		]);
	});

	it("uses the staged draft model when no runtime session exists", async () => {
		let draft = {
			model: { provider: "openai-codex", id: "gpt-5.5" } as SessionModel,
			thinkingLevel: "high",
		};
		const queriedModelKeys: string[] = [];
		const controller = new AppModelUsageController({
			runtimeSession: () => undefined,
			draftSelection: () => draft,
			render: () => {},
		}, async (descriptor) => {
			queriedModelKeys.push(descriptor.modelKey);
			return usageStatus(descriptor, descriptor.modelKey.endsWith("gpt-5.5") ? 73 : 41);
		});

		controller.observeSession(undefined);
		await settlePromises();
		assert.match(controller.statusLabel(), /^73%/u);

		draft = {
			model: { provider: "openai-codex", id: "gpt-5-mini" } as SessionModel,
			thinkingLevel: "medium",
		};
		controller.observeSession(undefined);
		await settlePromises();

		assert.match(controller.statusLabel(), /^41%/u);
		assert.deepEqual(queriedModelKeys, ["openai-codex/gpt-5.5", "openai-codex/gpt-5-mini"]);
	});

	it("force-refreshes staged draft usage without materializing a session", async () => {
		const draft = {
			model: { provider: "openai-codex", id: "gpt-5.5" } as SessionModel,
			thinkingLevel: "high",
		};
		let remainingPercent = 68;
		const controller = new AppModelUsageController({
			runtimeSession: () => undefined,
			draftSelection: () => draft,
			render: () => {},
		}, async (descriptor) => usageStatus(descriptor, remainingPercent));

		controller.observeSession(undefined);
		await settlePromises();
		assert.match(controller.statusLabel(), /^68%/u);

		remainingPercent = 52;
		const refresh = controller.refreshNow();
		assert.equal(refresh.kind, "started");
		if (refresh.kind !== "started") throw new Error("Expected started refresh");
		assert.equal(await refresh.promise, "refreshed");
		assert.match(controller.statusLabel(), /^52%/u);
	});

	it("reports an in-flight refresh without starting another request", () => {
		const activeSession = sessionWithModel("openai-codex", "gpt-5.5");
		let queryCount = 0;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			render: () => {},
		}, async (descriptor) => {
			queryCount++;
			return await new Promise<ModelUsageStatus>((resolve) => {
				setImmediate(() => resolve(usageStatus(descriptor, 80)));
			});
		});

		const first = controller.refreshNow();
		const second = controller.refreshNow();

		assert.equal(first.kind, "started");
		assert.equal(second.kind, "in-flight");
		assert.equal(queryCount, 1);
	});

	it("reports unsupported models without querying", () => {
		let queryCount = 0;
		const controller = new AppModelUsageController({
			runtimeSession: () => sessionWithModel("local", "llama"),
			render: () => {},
		}, async (descriptor) => {
			queryCount++;
			return usageStatus(descriptor, 10);
		});

		assert.deepEqual(controller.refreshNow(), { kind: "unsupported" });
		assert.equal(controller.statusLabel(), "");
		assert.equal(queryCount, 0);
	});

	it("clears active status when quota becomes unavailable", async () => {
		const activeSession = sessionWithModel("openai-codex", "gpt-5.5");
		let available = true;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			render: () => {},
		}, async (descriptor) => available ? usageStatus(descriptor, 80) : undefined);

		const first = controller.refreshNow();
		assert.equal(first.kind, "started");
		if (first.kind !== "started") throw new Error("Expected started refresh");
		assert.equal(await first.promise, "refreshed");
		assert.match(controller.statusLabel(), /^80%/u);

		available = false;
		const second = controller.refreshNow();
		assert.equal(second.kind, "started");
		if (second.kind !== "started") throw new Error("Expected started refresh");
		assert.equal(await second.promise, "unavailable");
		assert.equal(controller.statusLabel(), "");
	});

	it("keeps the previous status on transient query failures", async () => {
		const activeSession = sessionWithModel("openai-codex", "gpt-5.5");
		let shouldFail = false;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			render: () => {},
		}, async (descriptor) => {
			if (shouldFail) throw new Error("network");
			return usageStatus(descriptor, 64);
		});

		const first = controller.refreshNow();
		assert.equal(first.kind, "started");
		if (first.kind !== "started") throw new Error("Expected started refresh");
		await first.promise;

		shouldFail = true;
		const second = controller.refreshNow();
		assert.equal(second.kind, "started");
		if (second.kind !== "started") throw new Error("Expected started refresh");
		assert.equal(await second.promise, "failed");
		assert.match(controller.statusLabel(), /^64%/u);
	});

	it("starts polling only once and can stop it", () => {
		const activeSession = sessionWithModel("openai-codex", "gpt-5.5");
		let queryCount = 0;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			render: () => {},
		}, async (descriptor) => {
			queryCount++;
			return usageStatus(descriptor, 55);
		});

		controller.startPolling();
		controller.startPolling();
		controller.stopPolling();
		controller.stopPolling();

		assert.equal(queryCount, 1);
	});

	it("derives API-key Anthropic usage from response headers without provider queries", async () => {
		const activeSession = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-a");
		let queryCount = 0;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			anthropicAuthKind: () => Promise.resolve("api-key"),
			render: () => {},
		}, async (descriptor) => {
			queryCount++;
			return anthropicEndpointStatus(descriptor, 50);
		});

		controller.observeSession(activeSession);
		await settlePromises();
		controller.startPolling();
		controller.stopPolling();
		assert.deepEqual(controller.refreshNow(), { kind: "unsupported" });
		assert.equal(controller.statusLabel(), "");
		assert.equal(queryCount, 0);

		const recorded = controller.observeResponseHeaders({
			version: 1,
			sessionId: "session-a",
			modelRef: "anthropic/claude-sonnet-4-6",
			status: 200,
			headers: {
				"anthropic-ratelimit-requests-limit": "1000",
				"anthropic-ratelimit-requests-remaining": "500",
				"anthropic-ratelimit-requests-reset": "2025-07-01T12:00:30Z",
			},
		}, FIXED_NOW);
		assert.equal(recorded, true);
		assert.match(controller.statusLabel(), /^RPM 50%/u);
		assert.equal(queryCount, 0);
	});

	it("keeps polling the oauth usage endpoint for OAuth sessions and ignores their headers", async () => {
		const activeSession = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-a");
		const queriedKinds: string[] = [];
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			anthropicAuthKind: () => Promise.resolve("oauth"),
			render: () => {},
		}, async (descriptor) => {
			queriedKinds.push(descriptor.kind);
			return anthropicEndpointStatus(descriptor, 62);
		});

		controller.observeSession(activeSession);
		await settlePromises();
		assert.deepEqual(queriedKinds, ["anthropic"]);

		const refresh = controller.refreshNow();
		assert.equal(refresh.kind, "started");
		if (refresh.kind !== "started") throw new Error("Expected started refresh");
		assert.equal(await refresh.promise, "refreshed");
		assert.match(controller.statusLabel(), /^62%/u);

		// Header samples never override the authoritative subscription status.
		assert.equal(controller.observeResponseHeaders(headerPayload("session-a", "anthropic/claude-sonnet-4-6", "1000", "100"), FIXED_NOW), false);
		assert.match(controller.statusLabel(), /^62%/u);
	});

	it("defers the first header sample until the auth kind resolves to api-key", async () => {
		const activeSession = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-a");
		let resolveKind: ((kind: AnthropicAuthKind) => void) | undefined;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			anthropicAuthKind: () => new Promise<AnthropicAuthKind>((resolve) => {
				resolveKind = resolve;
			}),
			render: () => {},
		});

		controller.observeSession(activeSession);
		assert.equal(controller.observeResponseHeaders(headerPayload("session-a", "anthropic/claude-sonnet-4-6", "1000", "100"), FIXED_NOW), false);
		assert.equal(controller.statusLabel(), "");

		resolveKind?.("api-key");
		await settlePromises();
		assert.match(controller.statusLabel(), /^RPM 10%/u);
	});

	it("drops a pending header sample if its session closes before auth resolution", async () => {
		const activeSession = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-a");
		let resolveKind: ((kind: AnthropicAuthKind) => void) | undefined;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			anthropicAuthKind: () => new Promise<AnthropicAuthKind>((resolve) => {
				resolveKind = resolve;
			}),
			render: () => {},
		});
		controller.observeSession(activeSession);
		assert.equal(controller.observeResponseHeaders(headerPayload("session-a", "anthropic/claude-sonnet-4-6", "1000", "100"), FIXED_NOW), false);
		controller.forgetSessionSamples("session-a");
		resolveKind?.("api-key");
		await settlePromises();
		// Even if the same ID is reopened, its previous incarnation's pending
		// response must not reappear when auth classification eventually settles.
		controller.observeSession(sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-a"));
		assert.equal(controller.statusLabel(), "");
	});

	it("tolerates auth-kind resolution completing after the active model changed", async () => {
		let activeSession: AgentSession = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-a");
		let resolveKind: ((kind: AnthropicAuthKind) => void) | undefined;
		const queriedKinds: string[] = [];
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			anthropicAuthKind: () => new Promise<AnthropicAuthKind>((resolve) => {
				resolveKind = resolve;
			}),
			render: () => {},
		}, async (descriptor) => {
			queriedKinds.push(descriptor.kind);
			return usageStatus(descriptor, 62);
		});

		controller.observeSession(activeSession);
		// Switch away before the classifier answers: the stale completion must
		// neither crash nor query the anthropic usage endpoint afterwards.
		activeSession = sessionWithModel("openai-codex", "gpt-5.5");
		controller.observeSession(activeSession);

		resolveKind?.("oauth");
		await settlePromises();
		assert.deepEqual(queriedKinds, ["openai"]);
	});

	it("isolates API-key header usage per session and model", async () => {
		const sessionA = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-a");
		const sessionB = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-b");
		let activeSession: AgentSession = sessionA;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			anthropicAuthKind: () => Promise.resolve("api-key"),
			render: () => {},
		});

		controller.observeSession(activeSession);
		await settlePromises();
		assert.equal(controller.observeResponseHeaders(headerPayload("session-a", "anthropic/claude-sonnet-4-6", "1000", "100"), FIXED_NOW), true);
		assert.match(controller.statusLabel(), /^RPM 10%/u);

		// A sample captured by another open tab never repaints the active one.
		assert.equal(controller.observeResponseHeaders(headerPayload("session-b", "anthropic/claude-sonnet-4-6", "1000", "900"), FIXED_NOW), true);
		assert.match(controller.statusLabel(), /^RPM 10%/u);

		activeSession = sessionB;
		controller.observeSession(sessionB);
		assert.match(controller.statusLabel(), /^RPM 90%/u);

		// Switching the model within a session uses that model's own samples.
		assert.equal(controller.observeResponseHeaders(headerPayload("session-b", "anthropic/claude-opus-4-6", "1000", "400"), FIXED_NOW), true);
		const opusSession = sessionWithModel("anthropic", "claude-opus-4-6", "medium", "session-b");
		activeSession = opusSession;
		controller.observeSession(opusSession);
		assert.match(controller.statusLabel(), /^RPM 40%/u);

		activeSession = sessionA;
		controller.observeSession(sessionA);
		assert.match(controller.statusLabel(), /^RPM 10%/u);
	});

	it("clears a session's observed samples on teardown and preserves other sessions", async () => {
		const sessionA = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-a");
		const sessionB = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-b");
		let activeSession: AgentSession = sessionA;
		let renderCount = 0;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			anthropicAuthKind: () => Promise.resolve("api-key"),
			render: () => {
				renderCount++;
			},
		});

		controller.observeSession(activeSession);
		await settlePromises();
		assert.equal(controller.observeResponseHeaders(headerPayload("session-a", "anthropic/claude-sonnet-4-6", "1000", "100"), FIXED_NOW), true);
		assert.equal(controller.observeResponseHeaders(headerPayload("session-b", "anthropic/claude-sonnet-4-6", "1000", "900"), FIXED_NOW), true);
		assert.match(controller.statusLabel(), /^RPM 10%/u);

		// Teardown of session-a (tab close / disposal): its samples are dropped,
		// and because it was the visible route the status clears immediately.
		const rendersBeforeForget = renderCount;
		controller.forgetSessionSamples("session-a");
		assert.ok(renderCount > rendersBeforeForget);
		assert.equal(controller.statusLabel(), "");

		// The concurrently open session-b keeps its own samples untouched.
		activeSession = sessionB;
		controller.observeSession(sessionB);
		assert.match(controller.statusLabel(), /^RPM 90%/u);

		// Reopening session-a under the SAME session id is a fresh incarnation:
		// no stale sample may resurface before a new response arrives.
		const reopenedA = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-a");
		activeSession = reopenedA;
		controller.observeSession(reopenedA);
		assert.equal(controller.statusLabel(), "");
	});

	it("forgets only the samples of the torn-down session even when inactive", async () => {
		const sessionA = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-a");
		let activeSession: AgentSession = sessionA;
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			anthropicAuthKind: () => Promise.resolve("api-key"),
			render: () => {},
		});

		controller.observeSession(activeSession);
		await settlePromises();
		assert.equal(controller.observeResponseHeaders(headerPayload("session-a", "anthropic/claude-sonnet-4-6", "1000", "100"), FIXED_NOW), true);
		assert.match(controller.statusLabel(), /^RPM 10%/u);

		// A background tab's session-b closes while session-a stays active: no
		// render is triggered for the visible (unaffected) route.
		controller.forgetSessionSamples("session-b");
		assert.match(controller.statusLabel(), /^RPM 10%/u);

		// Unknown ids are a no-op.
		controller.forgetSessionSamples("session-never-seen");
		assert.match(controller.statusLabel(), /^RPM 10%/u);
	});

	it("purges the other usage source when the auth kind flips mid-session", async () => {
		const activeSession = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-a");
		let kind: AnthropicAuthKind = "api-key";
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			anthropicAuthKind: () => Promise.resolve(kind),
			render: () => {},
		}, async (descriptor) => anthropicEndpointStatus(descriptor, 62));

		const realNow = Date.now;
		let nowMs = FIXED_NOW;
		Date.now = () => nowMs;
		try {
			controller.observeSession(activeSession);
			await settlePromises();
			assert.equal(controller.observeResponseHeaders(headerPayload("session-a", "anthropic/claude-sonnet-4-6", "1000", "100"), nowMs), true);
			assert.match(controller.statusLabel(), /^RPM 10%/u);

			// Log in with OAuth between polls. Once re-classification lands, the
			// header sample must stop shadowing the oauth/usage endpoint status.
			kind = "oauth";
			nowMs += MODEL_USAGE_POLL_INTERVAL_MS + 1;
			assert.deepEqual(controller.refreshNow(), { kind: "unsupported" });
			await settlePromises();
			await settlePromises();
			assert.match(controller.statusLabel(), /^62%/u);
		} finally {
			Date.now = realNow;
		}
	});

	it("ignores header payloads that cannot describe an Anthropic model route", async () => {
		const activeSession = sessionWithModel("anthropic", "claude-sonnet-4-6", "medium", "session-a");
		const controller = new AppModelUsageController({
			runtimeSession: () => activeSession,
			anthropicAuthKind: () => Promise.resolve("api-key"),
			render: () => {},
		});
		controller.observeSession(activeSession);
		await settlePromises();

		assert.equal(controller.observeResponseHeaders(headerPayload("session-a", "openai-codex/gpt-5.5", "1000", "100"), FIXED_NOW), false);
		assert.equal(controller.observeResponseHeaders(headerPayload("session-a", "not-a-model-ref", "1000", "100"), FIXED_NOW), false);
		assert.equal(controller.observeResponseHeaders({
			version: 1,
			sessionId: "session-a",
			modelRef: "anthropic/claude-sonnet-4-6",
			status: 200,
			headers: {},
		}, FIXED_NOW), false);
		assert.equal(controller.statusLabel(), "");
	});
});

function sessionWithModel(provider: string, id: string, thinkingLevel = "medium", sessionId = "session-a"): AgentSession {
	return {
		model: { provider, id } as SessionModel,
		thinkingLevel,
		sessionId,
	} as unknown as AgentSession;
}

function headerPayload(sessionId: string, modelRef: string, limit: string, remaining: string) {
	return {
		version: 1 as const,
		sessionId,
		modelRef,
		status: 200,
		headers: {
			"anthropic-ratelimit-requests-limit": limit,
			"anthropic-ratelimit-requests-remaining": remaining,
			"anthropic-ratelimit-requests-reset": "2025-07-01T12:00:30Z",
		},
	};
}

function usageStatus(descriptor: ModelUsageDescriptor, remainingPercent: number): ModelUsageStatus {
	return {
		modelKey: descriptor.modelKey,
		provider: "openai",
		updatedAt: Date.now(),
		weekly: {
			remainingPercent,
			resetAt: Date.now() + 60 * 60 * 1000,
			windowSeconds: 7 * 24 * 60 * 60,
		},
	};
}

function anthropicEndpointStatus(descriptor: ModelUsageDescriptor, remainingPercent: number): ModelUsageStatus {
	return {
		modelKey: descriptor.modelKey,
		provider: "anthropic",
		updatedAt: Date.now(),
		hourly: {
			remainingPercent,
			resetAt: Date.now() + 60 * 60 * 1000,
			windowSeconds: 5 * 60 * 60,
			hasKnownWindowDuration: true,
		},
	};
}

async function settlePromises(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}
