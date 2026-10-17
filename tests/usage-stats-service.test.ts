import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UsageStatsService, type UsageStatsSource } from "../src/app/usage-stats/service.js";
import type { UsageSourceSnapshot, UsageSourceStatus } from "../src/app/usage-stats/types.js";

type Deferred = { resolve: (snapshot: UsageSourceSnapshot) => void; reject: (error: unknown) => void; signal: AbortSignal };

function controlledSource(): { source: UsageStatsSource; calls: Deferred[] } {
	const calls: Deferred[] = [];
	return {
		calls,
		source: {
			id: "pix-sessions",
			unit: "tokens",
			refreshIntervalMs: 60_000,
			minIntervalMs: 1_000,
			collect: (signal) => new Promise((resolve, reject) => {
				calls.push({ resolve, reject, signal });
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
		},
	};
}

const snapshot = (status: UsageSourceStatus, tokens = 0, message?: string): UsageSourceSnapshot => ({
	source: "pix-sessions", status, unit: "tokens", coverage: null, fetchedAtMs: 1,
	buckets: tokens > 0 ? [{ startMs: 0, width: "hour", provider: "zai", model: "m", values: { totalTokens: tokens } }] : [],
	...(message ? { message } : {}),
});

describe("UsageStatsService", () => {
	it("coalesces concurrent requests and retains the previous snapshot as stale while refreshing", async () => {
		let now = 0;
		const { source, calls } = controlledSource();
		const changes: string[] = [];
		const service = new UsageStatsService({ sources: [source], now: () => now, onChange: (id) => changes.push(id) });

		assert.equal(service.request()[0]?.status, "loading");
		service.request();
		assert.equal(calls.length, 1, "one in-flight collection per source");
		calls[0]!.resolve(snapshot("ready", 10));
		await service.settled();
		assert.deepEqual(changes, ["pix-sessions"]);
		assert.equal(service.request()[0]?.status, "ready");
		assert.equal(calls.length, 1, "refresh interval not elapsed");

		now = 500;
		service.request({ refresh: true });
		assert.equal(calls.length, 1, "explicit refresh still respects the minimum interval");
		now = 1_500;
		const refreshing = service.request({ refresh: true })[0];
		assert.equal(calls.length, 2);
		assert.equal(refreshing?.status, "stale");
		assert.equal(refreshing?.buckets[0]?.values.totalTokens, 10);
		calls[1]!.resolve(snapshot("ready", 20));
		await service.settled();
		assert.equal(service.request()[0]?.buckets[0]?.values.totalTokens, 20);
	});

	it("shows interim partial data only while cold and never over a retained snapshot", async () => {
		let now = 0;
		const calls: { resolve: (snapshot: UsageSourceSnapshot) => void; partial: (snapshot: UsageSourceSnapshot) => void }[] = [];
		const source: UsageStatsSource = {
			id: "pix-sessions", unit: "tokens", refreshIntervalMs: 60_000, minIntervalMs: 1_000,
			collect: (_signal, onPartial) => new Promise((resolve) => { calls.push({ resolve, partial: (value) => onPartial?.(value) }); }),
		};
		const changes: string[] = [];
		const service = new UsageStatsService({ sources: [source], now: () => now, onChange: (id) => changes.push(id) });
		service.request();
		calls[0]!.partial(snapshot("ready", 3, "recent only"));
		const interim = service.request()[0];
		assert.equal(interim?.status, "loading");
		assert.equal(interim?.buckets[0]?.values.totalTokens, 3);
		assert.equal(interim?.message, "recent only");
		assert.deepEqual(changes, ["pix-sessions"]);
		calls[0]!.resolve(snapshot("ready", 10));
		await service.settled();
		assert.equal(service.request()[0]?.status, "ready");

		now = 2_000;
		service.request({ refresh: true });
		calls[1]!.partial(snapshot("ready", 1));
		assert.equal(service.request()[0]?.buckets[0]?.values.totalTokens, 10, "partial never replaces retained data");
		calls[1]!.resolve(snapshot("ready", 11));
		await service.settled();
		assert.equal(service.request()[0]?.buckets[0]?.values.totalTokens, 11);
	});

	it("disposes sources with the service", () => {
		let disposed = 0;
		const { source } = controlledSource();
		const service = new UsageStatsService({ sources: [{ ...source, dispose: () => { disposed += 1; } }] });
		service.dispose();
		assert.equal(disposed, 1);
	});

	it("keeps good data as stale after transient failures and backs off", async () => {
		let now = 0;
		const { source, calls } = controlledSource();
		const logs: string[] = [];
		const service = new UsageStatsService({ sources: [source], now: () => now, log: (_level, event, details) => logs.push(`${event}:${String(details?.status ?? details?.error)}`) });
		service.request();
		calls[0]!.resolve(snapshot("ready", 10));
		await service.settled();

		now = 60_000;
		service.request();
		calls[1]!.resolve(snapshot("rate-limited", 0, "Rate limited; retrying later."));
		await service.settled();
		const kept = service.request()[0];
		assert.equal(kept?.status, "stale");
		assert.equal(kept?.buckets[0]?.values.totalTokens, 10);
		assert.equal(kept?.message, "Rate limited; retrying later.");

		now = 61_500;
		service.request({ refresh: true });
		assert.equal(calls.length, 2, "backoff (minInterval * 2^failures) blocks the retry");
		now = 62_100;
		service.request({ refresh: true });
		assert.equal(calls.length, 3);
		calls[2]!.reject(new TypeError("boom"));
		await service.settled();
		assert.equal(service.request()[0]?.status, "stale", "unexpected exceptions also keep good data");
		assert.deepEqual(logs, ["usage_stats.source_status:rate-limited", "usage_stats.collect_failed:TypeError", "usage_stats.source_status:error"]);
	});

	it("replaces data on auth failure", async () => {
		const { source, calls } = controlledSource();
		let now = 0;
		const service = new UsageStatsService({ sources: [source], now: () => now });
		service.request();
		calls[0]!.resolve(snapshot("ready", 10));
		await service.settled();
		now = 60_000;
		service.request();
		calls[1]!.resolve(snapshot("auth", 0, "Sign-in expired or not authorized."));
		await service.settled();
		const result = service.request()[0];
		assert.equal(result?.status, "auth");
		assert.deepEqual(result?.buckets, []);
	});

	it("aborts in-flight collections on dispose and drops their completions", async () => {
		const { source, calls } = controlledSource();
		const changes: string[] = [];
		const service = new UsageStatsService({ sources: [source], onChange: (id) => changes.push(id) });
		service.request();
		service.dispose();
		assert.equal(calls[0]?.signal.aborted, true);
		await service.settled();
		assert.deepEqual(changes, []);
		service.request();
		assert.equal(calls.length, 1, "no collection after dispose");
	});

	it("ignores unknown source ids and survives throwing listeners and loggers", async () => {
		const { source, calls } = controlledSource();
		const service = new UsageStatsService({
			sources: [source],
			onChange: () => { throw new Error("listener"); },
			log: () => { throw new Error("logger"); },
		});
		assert.deepEqual(service.request({ sources: ["unknown" as UsageSourceSnapshot["source"]] }), []);
		service.request();
		calls[0]!.resolve(snapshot("ready", 1));
		await service.settled();
		assert.equal(service.request()[0]?.status, "ready");
	});
});
