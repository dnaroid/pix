import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

test("system audio media deadline without capture", { skip: process.platform !== "darwin" }, async (t) => {
    mkdirSync(".pi/artifacts", { recursive: true });
    const run = mkdtempSync(resolve(".pi/artifacts/listener-audio-sink-tests-"));
    const binary = join(run, "audio-sink-test");
    const build = spawnSync("xcrun", ["swiftc", "-parse-as-library", "-target", "arm64-apple-macosx13.5",
        "scripts/audio-listener-probe/AudioSink.swift", "scripts/audio-listener-probe/Decode.swift", "scripts/audio-listener-probe/DecodeReference.swift",
        "scripts/audio-listener-probe/audio-sink-fixture.swift", "-o", binary], { encoding: "utf8", timeout: 60000 });
    assert.ifError(build.error);
    assert.equal(build.status, 0, build.stderr);
    for (const [mode, seconds] of [
        ["overrun", 1], ["overrun", 10], ["overrun", 120], ["crossing", 1], ["short", 1],
        ["late-gap", 1], ["validate-overrun", 1],
        ["overlap", 1], ["invalid-time", 1], ["wrong-format", 1], ["cancel", 1], ["empty", 1],
    ]) {
        await t.test(`${mode} ${seconds}s`, () => {
            const output = join(run, `${mode}-${seconds}.m4a`);
            const result = spawnSync(binary, [mode, String(seconds), output], { encoding: "utf8", timeout: 30000 });
            assert.ifError(result.error);
            assert.equal(result.status, 0, result.stderr);
            const data = JSON.parse(result.stdout);
            if (["overlap", "invalid-time", "wrong-format", "cancel", "empty", "validate-overrun"].includes(mode)) {
                assert.deepEqual(data, { rejected: true });
            } else {
                const expected = ["short", "late-gap"].includes(mode) ? 0.5 : seconds;
                assert.ok(data.durationSeconds <= expected, JSON.stringify(data));
                // Raw retained frames are checked exactly in Swift. AAC -> 16kHz
                // resampling can trim a fraction of a millisecond, never add time.
                assert.ok(data.durationSeconds >= expected - 0.001, JSON.stringify(data));
                assert.equal(statSync(`${output}.pcm`).size, data.bytes);
            }
        });
    }
});
