import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopForkQueue } from "../src/acp/desktop-fork-queue.js";
import type { DesktopForkChild, DesktopForkSnapshot } from "../src/acp/desktop-fork-snapshot.js";
import type { DesktopQueuedForkMessage, DesktopQueuedUserMessage } from "../src/acp/desktop-commands.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

const snapshot: DesktopForkSnapshot = { sessionPath: "/source.jsonl", leafId: "tool-result", cwd: "/workspace" };
const child: DesktopForkChild = { sessionPath: "/child.jsonl", piSessionId: "child" };
const message: DesktopQueuedUserMessage = { id: "queued", promptText: "expanded @file", displayText: "@file", images: [
	{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
] };

function harness() {
	let live = true;
	let idle = false;
	let createError: Error | undefined;
	let gate: Promise<DesktopForkChild> | undefined;
	let saveGate: Promise<void> | undefined;
	let persistGate: Promise<void> | undefined;
	let captureGate: Promise<DesktopForkSnapshot | undefined> | undefined;
	let announceError: Error | undefined;
	const snapshots: DesktopForkSnapshot[] = [];
	const saved: DesktopQueuedUserMessage[] = [];
	const announced: DesktopForkChild[] = [];
	const cleaned: DesktopForkChild[] = [];
	const cleanupComplete = deferred<void>();
	let durable: DesktopQueuedForkMessage[] = [];
	let changes = 0;
	const queue = new DesktopForkQueue({
		isLive: () => live,
		captureIdle: async () => captureGate ?? (idle ? { ...snapshot, leafId: "idle-leaf" } : undefined),
		create: async (value) => { snapshots.push(value); if (createError) throw createError; return gate ?? child; },
		saveChild: async (_child, value) => { saved.push(value); await saveGate; },
		announce: async (value) => { if (announceError) throw announceError; announced.push(value); },
		cleanup: async (value) => { cleaned.push(value); cleanupComplete.resolve(); },
		persist: async () => { await persistGate; durable = structuredClone(queue.messages); },
		changed: async () => { changes++; }, report: () => {},
	});
	return { queue, snapshots, saved, announced, cleaned, cleanupComplete: cleanupComplete.promise, get durable() { return durable; }, get changes() { return changes; },
		set live(value: boolean) { live = value; }, set idle(value: boolean) { idle = value; },
		set createError(value: Error | undefined) { createError = value; },
		set gate(value: Promise<DesktopForkChild>) { gate = value; },
		set saveGate(value: Promise<void>) { saveGate = value; },
		set persistGate(value: Promise<void> | undefined) { persistGate = value; },
		set captureGate(value: Promise<DesktopForkSnapshot | undefined>) { captureGate = value; },
		set announceError(value: Error) { announceError = value; },
	};
}

test("fork admission persists attachments separately; running waits for turn boundary, not settlement", async () => {
	const h = harness();
	await h.queue.admit(message);
	await h.queue.tryIdle();
	assert.equal(h.snapshots.length, 0);
	assert.deepEqual(h.durable, [message]);
	assert.deepEqual(h.queue.items()[0], { id: "fork:queued", source: "fork", mode: "fork", index: 0, text: "@file", message });
	const gate = deferred<DesktopForkChild>();
	h.gate = gate.promise;
	const boundary = { ...snapshot };
	h.queue.boundary(boundary);
	boundary.leafId = "later-assistant";
	h.queue.boundary({ ...snapshot, leafId: "settled-leaf" });
	assert.deepEqual(h.snapshots, [snapshot], "child job freezes the first turn_end leaf and ignores later boundaries");
	gate.resolve(child);
	await h.queue.settled();
	assert.deepEqual(h.saved, [message]);
	assert.deepEqual(h.announced, [child]);
	assert.deepEqual(h.durable, []);
	assert.deepEqual(h.cleaned, []);
});

test("idle fork starts from its immediately captured current leaf", async () => {
	const h = harness(); h.idle = true;
	await h.queue.admit(message);
	await h.queue.settled();
	assert.equal(h.snapshots[0]?.leafId, "idle-leaf");
	assert.deepEqual(h.saved[0]?.images, message.images);
	assert.deepEqual(h.announced, [child]);
});

test("turn_end wins over stale asynchronous idle capture", async () => {
	const h = harness();
	const capture = deferred<DesktopForkSnapshot | undefined>(); h.captureGate = capture.promise;
	await h.queue.admit(message);
	h.queue.boundary(snapshot);
	capture.resolve({ ...snapshot, leafId: "stale-idle" });
	await h.queue.settled();
	assert.deepEqual(h.snapshots, [snapshot]);
});

for (const action of ["cancel", "edit"] as const) {
	test(`pending fork ${action} invalidates creation and cleans its orphan`, async () => {
		const h = harness(); const gate = deferred<DesktopForkChild>(); h.gate = gate.promise;
		await h.queue.admit(message); h.queue.boundary(snapshot);
		assert.equal(await h.queue.take(0, "wrong"), undefined);
		assert.deepEqual(await h.queue.take(0, message.displayText), message);
		gate.resolve(child); await h.queue.settled();
		assert.deepEqual(h.saved, []); assert.deepEqual(h.announced, []); assert.deepEqual(h.cleaned, [child]);
	});
}

test("fork failure stays durable, visible, editable and is not retried by later boundaries or reload", async () => {
	const h = harness(); h.createError = new Error("disk full");
	await h.queue.admit(message); h.queue.boundary(snapshot); await h.queue.settled();
	assert.equal(h.queue.items()[0]?.error, "disk full");
	assert.equal(h.durable[0]?.error, "disk full");
	h.createError = undefined; h.queue.boundary(snapshot); await h.queue.tryIdle();
	assert.equal(h.snapshots.length, 1);
	h.queue.load(h.durable); h.queue.boundary(snapshot);
	assert.equal(h.snapshots.length, 1);
	assert.equal((await h.queue.take(0, message.displayText))?.promptText, message.promptText);
});

test("failed fork edit/cancel persistence restores the queued payload and its position", async () => {
	const h = harness();
	await h.queue.admit(message);
	const later = { ...message, id: "later", displayText: "later" };
	await h.queue.admit(later);
	h.persistGate = Promise.reject(new Error("disk full"));
	await assert.rejects(h.queue.take(0, message.displayText), /disk full/u);
	assert.deepEqual(h.queue.messages, [{ ...message, error: "disk full" }, later]);
	assert.deepEqual(h.durable, [message, later]);
	h.persistGate = undefined;
	assert.deepEqual(await h.queue.take(0, message.displayText), { ...message, error: "disk full" });
	assert.deepEqual(h.durable, [later]);
});

test("a stale take cannot mutate or persist after its source has retired", async () => {
	const h = harness();
	await h.queue.admit(message);
	h.queue.close();
	await h.queue.settled();
	await assert.rejects(h.queue.take(0, message.displayText), /source session closed/u);
	assert.deepEqual(h.queue.messages, [message]);
	assert.deepEqual(h.durable, [message]);
});

test("failed take overlapping child completion restores an actionable error instead of stranding an idle fork", async () => {
	const h = harness(); h.idle = true;
	const create = deferred<DesktopForkChild>(); h.gate = create.promise;
	await h.queue.admit(message);
	const write = deferred<void>();
	h.persistGate = write.promise.then(() => { throw new Error("take write failed"); });
	const take = h.queue.take(0, message.displayText);
	const failed = assert.rejects(take, /take write failed/u);
	create.resolve(child);
	// Complete child cleanup while take persistence still owns the absent item.
	await h.cleanupComplete;
	assert.deepEqual(h.cleaned, [child]);
	h.persistGate = undefined;
	write.resolve();
	await failed; await h.queue.settled();
	assert.equal(h.queue.items()[0]?.error, "take write failed");
	assert.equal(h.durable[0]?.error, "take write failed");
	assert.deepEqual(h.announced, []);
	assert.equal((await h.queue.take(0, message.displayText))?.promptText, message.promptText);
});

test("retirement joins a pending admission write before a replacement may hydrate", async () => {
	const h = harness();
	const gate = deferred<void>(); h.persistGate = gate.promise;
	const admission = h.queue.admit(message);
	h.live = false; h.queue.close();
	let retired = false;
	const retirement = h.queue.settled().then(() => { retired = true; });
	await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
	assert.equal(retired, false);
	gate.resolve();
	await admission; await retirement;
	assert.deepEqual(h.durable, [message]);
	assert.deepEqual(h.announced, []);
});

test("notification failure restores the source item and cleans the registered child", async () => {
	const h = harness(); h.announceError = new Error("connection lost");
	await h.queue.admit(message); h.queue.boundary(snapshot); await h.queue.settled();
	assert.equal(h.durable[0]?.error, "connection lost");
	assert.deepEqual(h.cleaned, [child]); assert.deepEqual(h.announced, []);
});

for (const stage of ["creating", "saving", "consuming"] as const) {
	test(`source close/exit invalidates fork while ${stage} and removes its orphan`, async () => {
		const h = harness();
		await h.queue.admit(message); await h.queue.tryIdle();
		const create = deferred<DesktopForkChild>(); const save = deferred<void>(); const persist = deferred<void>();
		if (stage === "creating") h.gate = create.promise;
		if (stage === "saving") h.saveGate = save.promise;
		if (stage === "consuming") h.persistGate = persist.promise;
		h.queue.boundary(snapshot);
		// Flush the deterministic create and save continuations (no sleeps/timers).
		await Promise.resolve(); await Promise.resolve();
		h.live = false; h.queue.close();
		create.resolve(child); save.resolve(); h.persistGate = undefined; persist.resolve();
		await h.queue.settled();
		assert.deepEqual(h.announced, []); assert.deepEqual(h.cleaned, [child]);
		assert.equal(h.queue.messages[0]?.id, message.id, "pending message survives source teardown");
	});
}

test("queue replacement cancels old snapshot work without touching restored messages", async () => {
	const h = harness(); const gate = deferred<DesktopForkChild>(); h.gate = gate.promise;
	await h.queue.admit(message); h.queue.boundary(snapshot);
	h.queue.load([{ ...message, id: "restored", error: "previous failure" }]);
	gate.resolve(child); await h.queue.settled();
	assert.equal(h.queue.messages[0]?.id, "restored"); assert.deepEqual(h.cleaned, [child]); assert.deepEqual(h.announced, []);
});

test("a turn boundary cannot spawn an item whose admission persistence has not completed", async () => {
	const gate = deferred<void>();
	const h = harness(); h.persistGate = gate.promise;
	const admission = h.queue.admit(message);
	h.queue.boundary(snapshot);
	assert.deepEqual(h.snapshots, []);
	gate.resolve(); h.persistGate = undefined;
	await admission;
	h.queue.boundary(snapshot); await h.queue.settled();
	assert.deepEqual(h.snapshots, [snapshot]);
});

test("idle leaf freezes before slow admission persistence even if the source advances meanwhile", async () => {
	const gate = deferred<void>();
	const h = harness(); h.idle = true; h.persistGate = gate.promise;
	const admission = h.queue.admit(message);
	await Promise.resolve(); await Promise.resolve();
	h.queue.boundary({ ...snapshot, leafId: "source-advanced" });
	assert.deepEqual(h.snapshots, [], "durable admission still precedes child creation");
	gate.resolve(); h.persistGate = undefined;
	await admission; await h.queue.settled();
	assert.equal(h.snapshots[0]?.leafId, "idle-leaf");
});
