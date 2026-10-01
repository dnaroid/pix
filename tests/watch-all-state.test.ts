import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DesktopWatchStatePublisher, desktopWatchState, parseDesktopWatchState } from "../scripts/watch-all-state.mjs";
import { PARTS, WatchAllSupervisor } from "../scripts/watch-all.mjs";

it("validates progress values while accepting legacy state", () => {
	for (const buildStatus of ["idle", "queued", "building", "failed"]) {
		assert.equal(parseDesktopWatchState(JSON.parse(desktopWatchState("/tmp/app", true, buildStatus)))?.buildStatus, buildStatus);
	}
	assert.equal(parseDesktopWatchState({ version: 1, target: "/tmp/app", stale: true, buildStatus: "bogus" }), undefined);
	assert.deepEqual(parseDesktopWatchState(JSON.parse(desktopWatchState("/tmp/app", false))), { target: "/tmp/app", stale: false });
});

it("serializes snapshots and retains the ready artifact across progress writes", async () => {
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const writes: unknown[] = [];
	const publisher = new DesktopWatchStatePublisher(async (...args: unknown[]) => {
		writes.push(args);
		if (writes.length === 1) await blocked;
	});
	const ready = publisher.publish("state", { target: "/tmp/ready", stale: true, buildStatus: "idle" });
	const queued = publisher.publish("state", { buildStatus: "queued" });
	const building = publisher.publish("state", { buildStatus: "building" });
	await Promise.resolve();
	assert.equal(writes.length, 1);
	release();
	await Promise.all([ready, queued, building]);
	assert.deepEqual(writes, [
		["state", "/tmp/ready", true, "idle"],
		["state", "/tmp/ready", true, "queued"],
		["state", "/tmp/ready", true, "building"],
	]);
});

it("publishes failure then recovery with mocked build steps, never launching Desktop", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "watch-state-test-"));
	const supervisor = new WatchAllSupervisor();
	supervisor.desktopWatchStatePath = join(temporary, "state.json");
	supervisor.initialBuild = false;
	supervisor.hasNativeBuild = true;
	supervisor.scheduleDesktopRestart = () => {};
	const status = async () => JSON.parse(await readFile(supervisor.desktopWatchStatePath, "utf8"));
	try {
		await supervisor.desktopStatePublisher.publish(supervisor.desktopWatchStatePath, { target: "/tmp/ready", stale: true });
		supervisor.pendingParts.add(PARTS.PIX);
		supervisor.runBuildStep = async () => {
			assert.equal((await status()).buildStatus, "building");
			throw new Error("mock compiler failure");
		};
		await supervisor.runQueuedBuild();
		assert.equal((await status()).buildStatus, "failed");
		assert.equal((await status()).stale, true);
		supervisor.queueParts([PARTS.PIX], "mock edit");
		clearTimeout(supervisor.buildTimer);
		await supervisor.desktopStatePublisher.pending;
		assert.equal((await status()).buildStatus, "queued");
		supervisor.runBuildStep = async () => {};
		await supervisor.runQueuedBuild();
		assert.equal((await status()).buildStatus, "idle");
		assert.equal((await status()).target, "/tmp/ready");
	} finally {
		clearTimeout(supervisor.buildTimer);
		await rm(temporary, { recursive: true, force: true });
	}
});

it("keeps building while another edit arrives, then publishes queued work", async () => {
	const supervisor = new WatchAllSupervisor();
	const states: string[] = [];
	supervisor.desktopWatchStatePath = "mock-state";
	supervisor.desktopStatePublisher = new DesktopWatchStatePublisher(async (_path: string, _target: string, _stale: boolean, status: string) => { states.push(status); });
	await supervisor.desktopStatePublisher.publish("mock-state", { target: "/tmp/ready", stale: true });
	supervisor.initialBuild = false;
	supervisor.hasNativeBuild = true;
	supervisor.pendingParts.add(PARTS.PIX);
	supervisor.runBuildStep = async () => {
		supervisor.queueParts([PARTS.ACP], "edit during mock build");
		await supervisor.desktopStatePublisher.pending;
		assert.equal(states.at(-1), "building");
	};
	try {
		await supervisor.runQueuedBuild();
		assert.equal(states.at(-1), "queued");
		assert.equal(supervisor.pendingParts.has(PARTS.ACP), true);
	} finally {
		clearTimeout(supervisor.buildTimer);
	}
});

it("recovers the serialized publication queue after a write failure", async () => {
	let calls = 0;
	const publisher = new DesktopWatchStatePublisher(async () => {
		if (++calls === 1) throw new Error("mock write failure");
	});
	await assert.rejects(publisher.publish("mock-state", { target: "/tmp/ready", stale: false }), /mock write failure/u);
	await publisher.publish("mock-state", { buildStatus: "building" });
	assert.equal(calls, 2);
});
