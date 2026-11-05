import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import test from "node:test";

// Explicit opt-in binary: these checks never record audio or request OS permissions.
const binary = process.env.LISTENER_PROBE_BIN && resolve(process.env.LISTENER_PROBE_BIN);
const artifacts = resolve(".pi/artifacts");
mkdirSync(artifacts, { recursive: true });
const run = mkdtempSync(join(artifacts, "listener-native-tests-"));

function invoke(args) {
	const result = spawnSync(binary, args, { encoding: "utf8", timeout: 15_000 });
	assert.ifError(result.error);
	return result;
}

function wave(seconds = 1, sampleRate = 8000) {
	const samples = sampleRate * seconds;
	const bytes = samples * 2;
	const data = Buffer.alloc(44 + bytes);
	data.write("RIFF", 0);
	data.writeUInt32LE(36 + bytes, 4);
	data.write("WAVEfmt ", 8);
	data.writeUInt32LE(16, 16);
	data.writeUInt16LE(1, 20);
	data.writeUInt16LE(1, 22);
	data.writeUInt32LE(sampleRate, 24);
	data.writeUInt32LE(sampleRate * 2, 28);
	data.writeUInt16LE(2, 32);
	data.writeUInt16LE(16, 34);
	data.write("data", 36);
	data.writeUInt32LE(bytes, 40);
	return data;
}

test("native listener feasibility probe (no capture or STT)", { skip: !binary }, async (t) => {
	await t.test("streams resampled PCM16 mono without changing the original", () => {
		const input = join(run, "silence.wav");
		const output = join(run, "silence.pcm");
		const original = wave();
		writeFileSync(input, original);
		const result = invoke(["decode", input, output]);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {
			bytes: 32000, channels: 1, durationSeconds: 1, format: "s16le", sampleRate: 16000,
		});
		assert.deepEqual(readFileSync(output), Buffer.alloc(32000));
		assert.deepEqual(readFileSync(input), original);
	});
	await t.test("will not overwrite an existing output or source", () => {
		const input = join(run, "silence.wav");
		const original = readFileSync(input);
		const result = invoke(["decode", input, input]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /output already exists/);
		assert.deepEqual(readFileSync(input), original);
	});
	await t.test("decodes the exact 120-second PCM boundary", () => {
		const input = join(run, "boundary.wav");
		const output = join(run, "boundary.pcm");
		writeFileSync(input, wave(120, 16000));
		const result = invoke(["decode", input, output]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).durationSeconds, 120);
		assert.deepEqual(readFileSync(output), Buffer.alloc(120 * 32000));
	});
	await t.test("rejects excessive duration without publishing output", () => {
		const input = join(run, "long.wav");
		const output = join(run, "long.pcm");
		writeFileSync(input, wave(121));
		const result = invoke(["decode", input, output]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /duration/);
		assert.equal(existsSync(output), false);
	});
	await t.test("rejects malformed media without publishing output", () => {
		const input = join(run, "invalid.wav");
		const output = join(run, "invalid.pcm");
		writeFileSync(input, "not audio");
		assert.equal(invoke(["decode", input, output]).status, 1);
		assert.equal(existsSync(output), false);
	});
	await t.test("capture rejects missing acknowledgment and unsafe durations before touching permissions", () => {
		for (const args of [
			["capture", "1", join(run, "forbidden.m4a")],
			...["0", "121", "-1", "1.5"].map((value) => ["capture", "--acknowledge-general-system-audio", value, join(run, "forbidden.m4a")]),
		]) {
			const result = invoke(args);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /acknowledge-general-system-audio/);
		}
		assert.equal(existsSync(join(run, "forbidden.m4a")), false);
	});
	await t.test("valid capture parameters still cannot grant consent from a noninteractive agent shell", () => {
		const output = join(run, "no-consent.m4a");
		const result = invoke(["capture", "--acknowledge-general-system-audio", "1", output]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /interactive terminal and typed user confirmation/);
		assert.equal(existsSync(output), false);
	});
	await t.test("microphone rejects missing acknowledgment, mixed flags and invalid duration before permissions", () => {
		const output = join(run, "forbidden-microphone.caf");
		for (const args of [
			["microphone", "1", output],
			["microphone", "--acknowledge-general-system-audio", "1", output],
			["microphone", "--acknowledge-microphone", "1", output, "--system"],
			...["0", "121", "-1", "1.5", "NaN"].map((value) => ["microphone", "--acknowledge-microphone", value, output]),
		]) {
			const result = invoke(args);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /microphone --acknowledge-microphone/);
		}
		assert.equal(existsSync(output), false);
	});
	await t.test("microphone cannot bypass interactive consent", () => {
		const output = join(run, "no-consent-microphone.caf");
		const result = invoke(["microphone", "--acknowledge-microphone", "1", output]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /interactive terminal and typed user confirmation/);
		assert.equal(existsSync(output), false);
	});
});
