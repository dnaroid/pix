import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import type { Logger } from "../src/logging.js";
import type { UsageSourceId, UsageSourceSnapshot, UsageStatsChangedNotification } from "../src/acp/usage-stats-contract.js";
import { parseUsageStatsRequest, UsageStatsHost, type UsageStatsModule, type UsageStatsServiceLike } from "../src/acp/usage-stats-host.js";

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

type FakeService = UsageStatsServiceLike & {
	disposed: boolean;
	requests: { sources?: readonly UsageSourceId[]; refresh?: boolean }[];
	change(source: UsageSourceId): void;
};

function fakeModule(restore: () => Promise<void> = async () => {}) {
	const services: FakeService[] = [];
	const module: UsageStatsModule = {
		createUsageStatsSources: () => ["pix"],
		UsageStatsService: class {
			constructor(options: { sources: readonly unknown[]; onChange?: (source: UsageSourceId) => void }) {
				const service: FakeService = {
					disposed: false,
					requests: [],
					restore,
					request(request) {
						service.requests.push(request);
						return (request.sources ?? ["pix-sessions"]).map((source): UsageSourceSnapshot => ({
							source, status: "loading", unit: "tokens", coverage: null, buckets: [], fetchedAtMs: 0,
						}));
					},
					settled: async () => {},
					dispose() { service.disposed = true; },
					change(source) { options.onChange?.(source); },
				};
				services.push(service);
				return service;
			}
		} as unknown as UsageStatsModule["UsageStatsService"],
	};
	return { module, services };
}

test("serves every workspace from one shared service", async () => {
	const { module, services } = fakeModule();
	const host = new UsageStatsHost({ logger: silentLogger, agentDir: "/agent", load: async () => module });
	const notify = async () => {};

	const all = await host.stats({ cwd: "/work/a" }, notify);
	assert.deepEqual(all.snapshots.map((s) => s.source), ["pix-sessions"]);
	await host.stats({ cwd: "/work/b", sources: ["pix-sessions"], refresh: true }, notify);
	assert.equal(services.length, 1, "cwd does not create per-project services");
	assert.deepEqual(services[0]!.requests, [{}, { sources: ["pix-sessions"], refresh: true }]);
	await host.dispose();
});

test("gates all concurrent requests on restore and forwards the selected profile", async () => {
	let release!: () => void;
	const restore = new Promise<void>((resolve) => { release = resolve; });
	const { module, services } = fakeModule(() => restore);
	let profile: string | undefined;
	module.createUsageStatsSources = (options) => { profile = options.agentDir; return []; };
	const host = new UsageStatsHost({ logger: silentLogger, agentDir: "/profile", load: async () => module });
	const requests = [host.stats({ cwd: "/a" }, async () => {}), host.stats({ cwd: "/b" }, async () => {})];
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(services.length, 1);
	assert.equal(services[0]?.requests.length, 0);
	assert.equal(profile, "/profile");
	release();
	await Promise.all(requests);
	assert.equal(services[0]?.requests.length, 2);
	await host.dispose();
});

test("does not collect when disposed during a disk restore", async () => {
	let release!: () => void;
	const restore = new Promise<void>((resolve) => { release = resolve; });
	const { module, services } = fakeModule(() => restore);
	const host = new UsageStatsHost({ logger: silentLogger, agentDir: "/agent", load: async () => module });
	const pending = host.stats({ cwd: "/a" }, async () => {});
	const rejected = assert.rejects(pending, RequestError);
	await new Promise((resolve) => setImmediate(resolve));
	await host.dispose();
	release();
	await rejected;
	assert.equal(services[0]?.requests.length, 0);
});

test("notifies only the latest requester and stops after dispose", async () => {
	const { module, services } = fakeModule();
	const host = new UsageStatsHost({ logger: silentLogger, agentDir: "/agent", load: async () => module });
	const first: UsageStatsChangedNotification[] = [];
	const latest: UsageStatsChangedNotification[] = [];
	await host.stats({ cwd: "/work/a" }, async (n) => { first.push(n); });
	await host.stats({ cwd: "/work/b" }, async (n) => { latest.push(n); });

	services[0]!.change("pix-sessions");
	assert.deepEqual(first, []);
	assert.deepEqual(latest, [{ source: "pix-sessions" }]);

	await host.dispose();
	assert.equal(services[0]!.disposed, true);
	services[0]!.change("pix-sessions");
	assert.equal(latest.length, 1, "no notifications after dispose");
	await assert.rejects(host.stats({ cwd: "/work/a" }, async () => {}), RequestError);
});

test("module load failure maps to a server error and is retried", async () => {
	const { module } = fakeModule();
	const errors: string[] = [];
	let attempts = 0;
	const host = new UsageStatsHost({
		agentDir: "/agent",
		logger: { ...silentLogger, error: (message) => { errors.push(message); } },
		load: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("missing dist");
			return module;
		},
	});
	await assert.rejects(host.stats({ cwd: "/a" }, async () => {}), (error: unknown) => error instanceof RequestError && error.code === -32000);
	assert.equal(errors.length, 1);
	assert.ok(!errors[0]!.includes("missing dist"), "error text is not logged verbatim");
	const response = await host.stats({ cwd: "/a" }, async () => {});
	assert.equal(response.snapshots.length, 1);
	await host.dispose();
});

test("parseUsageStatsRequest validates cwd, sources and refresh", () => {
	assert.deepEqual(parseUsageStatsRequest({ cwd: "/a" }), { cwd: "/a" });
	assert.deepEqual(
		parseUsageStatsRequest({ cwd: "/a", sources: ["pix-sessions", "pix-sessions"], refresh: true }),
		{ cwd: "/a", sources: ["pix-sessions"], refresh: true },
	);
	assert.deepEqual(parseUsageStatsRequest({ cwd: "/a", refresh: false }), { cwd: "/a" });
	for (const invalid of [null, [], {}, { cwd: " " }, { cwd: "/a", sources: ["codex-local"] }, { cwd: "/a", sources: "pix-sessions" }, { cwd: "/a", refresh: "yes" }]) {
		assert.throws(() => parseUsageStatsRequest(invalid), (error: unknown) => error instanceof RequestError && error.code === -32602);
	}
});

test("warm loads and restores once without collecting; later stats reuse it", async () => {
	const { module, services } = fakeModule();
	let loads = 0;
	const host = new UsageStatsHost({ logger: silentLogger, agentDir: "/agent", load: async () => { loads += 1; return module; } });
	await host.warm();
	assert.equal(loads, 1);
	assert.equal(services.length, 1);
	assert.equal(services[0]!.requests.length, 0, "warmup never collects");
	await host.stats({ cwd: "/a" }, async () => {});
	assert.equal(loads, 1);
	assert.equal(services.length, 1);
	assert.equal(services[0]!.requests.length, 1);
	await host.dispose();
});

test("warm swallows load failures and is a no-op after dispose", async () => {
	const { module, services } = fakeModule();
	let fail = true;
	const host = new UsageStatsHost({ logger: silentLogger, agentDir: "/agent", load: async () => { if (fail) throw new Error("x"); return module; } });
	await host.warm();
	fail = false;
	const response = await host.stats({ cwd: "/a" }, async () => {});
	assert.equal(response.snapshots.length, 1);
	await host.dispose();
	await host.warm();
	assert.equal(services.length, 1);
});
