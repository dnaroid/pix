import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import {
	PARTS,
	WatchAllSupervisor,
	desktopLaunchExecutable,
	usesDesktopAppBundle,
} from "../scripts/watch-all.mjs";

async function runtimeFixture(t: TestContext) {
	const artifacts = resolve(".pi/artifacts");
	await mkdir(artifacts, { recursive: true });
	const root = await mkdtemp(join(artifacts, "watch-all-runtime-"));
	const supervisor = new WatchAllSupervisor();
	t.after(async () => {
		clearTimeout(supervisor.buildTimer);
		clearTimeout(supervisor.restartTimer);
		await supervisor.desktopStatePublisher.pending;
		await rm(root, { recursive: true, force: true });
	});
	const original = desktopLaunchExecutable(join(root, "original", "Pix Desktop.app"));
	await mkdir(resolve(original, ".."), { recursive: true });
	await writeFile(original, "successful native output");
	supervisor.tempDirectory = root;
	supervisor.desktopWatchStatePath = join(root, "state.json");
	supervisor.desktopExecutable = original;
	supervisor.desktopRunningExecutable = original;
	supervisor.desktopProcess = { pid: 123, exitCode: null, signalCode: null };
	supervisor.initialBuild = false;
	supervisor.hasNativeBuild = true;
	supervisor.pruneDesktopArtifacts = async () => {};
	supervisor.scheduleDesktopRestart = () => { assert.fail("running Desktop must wait for user Restart"); };
	const commands: string[] = [];
	supervisor.runCommand = async (label: string) => { commands.push(label); };
	await supervisor.desktopStatePublisher.publish(supervisor.desktopWatchStatePath, { target: original, stale: false });
	const state = async () => JSON.parse(await readFile(supervisor.desktopWatchStatePath, "utf8"));
	return { supervisor, original, state, commands };
}

for (const part of [PARTS.SUITE, PARTS.PIX, PARTS.ACP]) {
	it(`offers Restart after ${part} succeeds using a distinct copy of the existing Desktop`, async (t) => {
		const { supervisor, original, state, commands } = await runtimeFixture(t);
		const steps: string[] = [];
		supervisor.runBuildStep = async (step: string) => {
			steps.push(step);
			assert.deepEqual(await state(), { version: 1, target: original, stale: false, buildStatus: "building" });
		};
		supervisor.pendingParts.add(part);
		await supervisor.runQueuedBuild();
		assert.deepEqual(steps, [part]);
		assert.notEqual(supervisor.desktopExecutable, original);
		assert.equal(await readFile(supervisor.desktopExecutable, "utf8"), "successful native output");
		assert.equal(await readFile(original, "utf8"), "successful native output");
		assert.deepEqual(await state(), {
			version: 1, target: supervisor.desktopExecutable, stale: true, buildStatus: "idle",
		});
		assert.equal(supervisor.desktopRevision, 1);
		assert.equal(supervisor.restartPending, false);
		assert.deepEqual(commands, usesDesktopAppBundle() ? ["sign desktop bundle for stable macOS permissions"] : []);
	});
}

it("keeps the last ready artifact when a runtime build fails, then retries all failed parts", async (t) => {
	const { supervisor, state } = await runtimeFixture(t);
	supervisor.runBuildStep = async () => {};
	supervisor.pendingParts.add(PARTS.PIX);
	await supervisor.runQueuedBuild();
	const ready = supervisor.desktopExecutable;
	const sequence = supervisor.executableSequence;
	supervisor.runBuildStep = async (step: string) => {
		if (step === PARTS.ACP) throw new Error("mock ACP compiler failure");
	};
	supervisor.pendingParts.add(PARTS.PIX);
	supervisor.pendingParts.add(PARTS.ACP);
	await supervisor.runQueuedBuild();
	assert.equal(supervisor.executableSequence, sequence);
	assert.deepEqual(await state(), { version: 1, target: ready, stale: true, buildStatus: "failed" });
	assert.deepEqual([...supervisor.blockedParts], [PARTS.PIX, PARTS.ACP]);
	supervisor.queueParts([PARTS.SUITE], "retry after failure");
	clearTimeout(supervisor.buildTimer);
	const steps: string[] = [];
	supervisor.runBuildStep = async (step: string) => { steps.push(step); };
	await supervisor.runQueuedBuild();
	assert.deepEqual(steps, [PARTS.SUITE, PARTS.PIX, PARTS.ACP]);
	assert.notEqual(supervisor.desktopExecutable, ready);
	assert.equal((await state()).buildStatus, "idle");
	assert.equal(supervisor.blockedParts.size, 0);
	assert.equal(supervisor.lastBuildFailure, undefined);
});

it("retains queued runtime parts when artifact preparation fails during another edit", async (t) => {
	const { supervisor, original, state } = await runtimeFixture(t);
	const copyArtifact = supervisor.copyDesktopArtifact.bind(supervisor);
	supervisor.runBuildStep = async () => {};
	supervisor.copyDesktopArtifact = async () => {
		supervisor.queueParts([PARTS.ACP], "edit while copying runtime artifact");
		throw new Error("mock copy failure");
	};
	supervisor.pendingParts.add(PARTS.PIX);
	await supervisor.runQueuedBuild();
	clearTimeout(supervisor.buildTimer);
	assert.deepEqual(new Set(supervisor.pendingParts), new Set([PARTS.PIX, PARTS.ACP]));
	assert.deepEqual(await state(), { version: 1, target: original, stale: false, buildStatus: "queued" });
	assert.equal(supervisor.desktopRevision, 0);
	supervisor.copyDesktopArtifact = copyArtifact;
	const steps: string[] = [];
	supervisor.runBuildStep = async (step: string) => { steps.push(step); };
	await supervisor.runQueuedBuild();
	assert.deepEqual(steps, [PARTS.PIX, PARTS.ACP]);
	assert.notEqual(supervisor.desktopExecutable, original);
	assert.equal((await state()).stale, true);
});

it("does not recopy an artifact already captured by the native build", async (t) => {
	const { supervisor, original, state } = await runtimeFixture(t);
	const next = join(supervisor.tempDirectory, "native-artifact");
	supervisor.runBuildStep = async (step: string) => {
		assert.equal(step, PARTS.NATIVE);
		supervisor.desktopExecutable = next;
	};
	supervisor.copyDesktopArtifact = async () => { assert.fail("native step already captured its new artifact"); };
	supervisor.pendingParts.add(PARTS.NATIVE);
	await supervisor.runQueuedBuild();
	assert.notEqual(next, original);
	assert.equal((await state()).target, next);
	assert.equal((await state()).stale, true);
});
