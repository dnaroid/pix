import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createPixSessionsSource } from "../src/app/usage-stats/pix-sessions.js";
import type { UsageBucket } from "../src/app/usage-stats/types.js";
import { WorkerCollector } from "../src/app/usage-stats/worker-collector.js";

const total = (buckets: readonly UsageBucket[]) => buckets.reduce((sum, bucket) => sum + (bucket.values.totalTokens ?? 0), 0);

describe("usage-stats worker collector", () => {
	let dir: string;
	let roots: string[];
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pix-usage-worker-"));
		const sessionDir = join(dir, "sessions", "--work--");
		await mkdir(sessionDir, { recursive: true });
		const at = "2026-10-16T09:00:00.000Z";
		await writeFile(join(sessionDir, "a.jsonl"), [
			{ type: "session", id: "s", cwd: "/work" },
			{ type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "assistant", provider: "zai", model: "glm", timestamp: Date.parse(at), usage: { input: 6, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { total: 0 } } } },
		].map((row) => `${JSON.stringify(row)}\n`).join(""));
		roots = [join(dir, "sessions")];
	});
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("collects in a worker thread with the same result as in-process collection", async () => {
		let fallbacks = 0;
		const collector = new WorkerCollector({
			id: "pix-sessions",
			roots: () => roots,
			fallback: () => { fallbacks += 1; return createPixSessionsSource({ roots: () => roots }); },
		});
		try {
			const viaWorker = await collector.collect();
			const inProcess = await createPixSessionsSource({ roots: () => roots }).collect();
			assert.equal(fallbacks, 0, "worker started");
			assert.deepEqual(viaWorker.snapshot.buckets, inProcess.snapshot.buckets);
			assert.equal(total(viaWorker.snapshot.buckets), 9);
		} finally {
			collector.dispose();
		}
	});

	it("falls back to in-process collection once when the worker cannot start", async () => {
		const logs: string[] = [];
		let fallbacks = 0;
		const collector = new WorkerCollector({
			id: "pix-sessions",
			roots: () => roots,
			fallback: () => { fallbacks += 1; return createPixSessionsSource({ roots: () => roots }); },
			log: (_level, event) => logs.push(event),
			workerUrl: new URL("./missing-collect-worker.js", import.meta.url),
		});
		try {
			assert.equal(total((await collector.collect()).snapshot.buckets), 9);
			assert.equal(total((await collector.collect()).snapshot.buckets), 9);
			assert.equal(fallbacks, 1);
			assert.deepEqual(logs, ["usage_stats.worker_unavailable"]);
		} finally {
			collector.dispose();
		}
	});

	it("restores a saved snapshot in a fresh worker without scanning session logs", async () => {
		const snapshotPath = join(dir, "cache", "history.json");
		const options = { id: "pix-sessions" as const, roots: () => roots, snapshotPath,
			fallback: () => { throw new Error("worker must be available"); } };
		const original = new WorkerCollector(options);
		assert.equal(await original.restore(), undefined);
		const collected = await original.collect();
		original.dispose();
		await rm(join(dir, "sessions"), { recursive: true });
		const restarted = new WorkerCollector(options);
		try {
			assert.deepEqual((await restarted.restore())?.buckets, collected.snapshot.buckets);
			assert.equal(total((await restarted.collect()).snapshot.buckets), 0, "live scan replaces saved data with the current empty source");
		} finally { restarted.dispose(); }
	});

	it("rejects aborted and disposed collections", async () => {
		const collector = new WorkerCollector({ id: "pix-sessions", roots: () => roots, fallback: () => createPixSessionsSource({ roots: () => roots }) });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(collector.collect(controller.signal));
		collector.dispose();
		await assert.rejects(collector.collect(), /disposed/u);
	});
});
