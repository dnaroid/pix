import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { AppModelUsageController, type AppModelUsageQuery } from "../src/app/model/model-usage-controller.js";
import type { ModelUsageDescriptor, ModelUsageStatus } from "../src/app/model/model-usage-status.js";
import type { SessionModel } from "../src/app/types.js";

describe("model usage controller", () => {
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
});

function sessionWithModel(provider: string, id: string): AgentSession {
	return {
		model: { provider, id } as SessionModel,
	} as unknown as AgentSession;
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

async function settlePromises(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}
