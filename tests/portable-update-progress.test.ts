import assert from "node:assert/strict";
import { test } from "node:test";
import { createPortableUpdateProgress } from "../src/app/cli/portable-update-progress.js";

test("portable update progress prints stages in redirected output without animation", () => {
	const writes: string[] = [];
	const progress = createPortableUpdateProgress({ write: (text) => writes.push(text), isTTY: false });
	progress.stage("Downloading Pix...");
	progress.stage("Verifying checksum...");
	progress.stop();
	assert.deepEqual(writes, ["Downloading Pix...\n", "Verifying checksum...\n"]);
});

test("portable update progress clears its terminal line on completion or failure", () => {
	const writes: string[] = [];
	const progress = createPortableUpdateProgress({ write: (text) => writes.push(text), isTTY: true });
	progress.stage("Downloading Pix...");
	progress.stage("Smoke-testing Pix...");
	progress.stop();
	progress.stop();
	assert.match(writes[0]!, /^\r\x1b\[2K\| Downloading Pix\.\.\.$/u);
	assert.match(writes[1]!, /Smoke-testing Pix\.\.\.$/u);
	assert.equal(writes[writes.length - 1], "\r\x1b[2K");
	assert.equal(writes.length, 3);
});
