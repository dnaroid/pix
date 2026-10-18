import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CachedUsageCollector } from "../src/app/usage-stats/snapshot-cache.js";
import { UsageStatsService, localUsageStatsSource } from "../src/app/usage-stats/service.js";
import type { LocalUsageCollectResult, LocalUsageCollector } from "../src/app/usage-stats/local-source.js";
import type { UsageSourceSnapshot } from "../src/app/usage-stats/types.js";

const snapshot = (calls = 5): UsageSourceSnapshot => ({
	source: "pix-sessions", status: "ready", unit: "tokens", coverage: null, fetchedAtMs: 123,
	buckets: [{ startMs: 0, width: "hour", provider: "openai", model: "gpt", projectCwd: "/a", values: { calls } }],
	sessions: [{ sessionId: "s", projectCwd: "/a", userTurns: 1 }],
});
const result = (value: UsageSourceSnapshot): LocalUsageCollectResult => ({ snapshot: value, skipped: [], malformedLines: 0, duplicateRecords: 0 });

describe("persistent usage snapshots", () => {
	let directory: string;
	let path: string;
	beforeEach(async () => {
		await mkdir(".pi/artifacts", { recursive: true });
		directory = await mkdtemp(".pi/artifacts/usage-snapshot-test-");
		path = join(directory, "cache", "history.json");
	});
	afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

	it("restores complete global data before collection, marks it stale and ignores cold partials", async () => {
		const original = new CachedUsageCollector({ id: "pix-sessions", collect: async () => result(snapshot()) }, path);
		await original.collect();
		let finish!: (value: LocalUsageCollectResult) => void;
		let calls = 0;
		const local: LocalUsageCollector = { id: "pix-sessions", collect: (_signal, partial) => {
			calls++;
			partial?.({ ...snapshot(1), status: "loading" });
			return new Promise((resolve) => { finish = resolve; });
		} };
		const restored = new CachedUsageCollector(local, path);
		const service = new UsageStatsService({ sources: [localUsageStatsSource(restored)] });
		await service.restore();
		assert.equal(calls, 0, "restore does not collect or poll");
		const warm = service.request()[0]!;
		assert.equal(warm.status, "stale");
		assert.equal(warm.buckets[0]?.values.calls, 5, "partial never replaces saved full history");
		assert.equal(calls, 1, "opening starts one background refresh");
		finish(result(snapshot(8)));
		await service.settled();
		assert.equal((await restored.restore())?.buckets[0]?.values.calls, 8);
		if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600); // Windows uses ACLs, not POSIX mode bits.
		service.dispose();
	});

	it("does not replace a good disk snapshot with partials or errors", async () => {
		let value = snapshot();
		const cache = new CachedUsageCollector({ id: "pix-sessions", collect: async () => result(value) }, path);
		await cache.collect();
		for (const status of ["loading", "error", "unavailable", "stale"] as const) {
			value = { ...snapshot(1), status };
			await cache.collect();
			assert.equal((await cache.restore())?.buckets[0]?.values.calls, 5);
		}
	});

	it("ignores missing, corrupt, incompatible and invalid caches; logs without payloads once", async () => {
		const events: string[] = [];
		const cache = new CachedUsageCollector({ id: "pix-sessions", collect: async () => result(snapshot()) }, path,
			(_level, event, details) => events.push(`${event}:${JSON.stringify(details)}`));
		assert.equal(await cache.restore(), undefined);
		assert.equal(events.length, 0);
		await mkdir(join(directory, "cache"));
		for (const raw of ["secret malformed json", JSON.stringify({ version: 2, data: snapshot() }), JSON.stringify({ version: 1, data: { ...snapshot(), buckets: [{}] } })]) {
			await writeFile(path, raw);
			assert.equal(await cache.restore(), undefined);
		}
		assert.equal(events.length, 1);
		assert.ok(!events[0]?.includes("secret"));
		await cache.collect();
		assert.equal((await cache.restore())?.status, "ready", "live success repairs a disposable bad cache");
		assert.ok((await readFile(path, "utf8")).includes('"version":1'));
	});

	it("does not apply a restore after disposal or over a newer live snapshot", async () => {
		let restore!: (value: UsageSourceSnapshot) => void;
		const source = localUsageStatsSource({ id: "pix-sessions", restore: () => new Promise((resolve) => { restore = resolve; }), collect: async () => result(snapshot(9)) });
		const service = new UsageStatsService({ sources: [source] });
		const pending = service.restore();
		service.request();
		await service.settled();
		restore(snapshot(1));
		await pending;
		assert.equal(service.request()[0]?.buckets[0]?.values.calls, 9);
		service.dispose();
		const late = new UsageStatsService({ sources: [source] });
		const loading = late.restore();
		late.dispose();
		restore(snapshot());
		await loading;
		assert.equal(late.request()[0]?.status, "unavailable");
	});
});
