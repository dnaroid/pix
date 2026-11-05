import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

test("decode reference and publication without capture", { skip: process.platform !== "darwin" }, async (t) => {
    mkdirSync(".pi/artifacts", { recursive: true });
    const run = mkdtempSync(resolve(".pi/artifacts/listener-decode-tests-"));
    const binary = join(run, "decode-test");
    const build = spawnSync("xcrun", ["swiftc", "-parse-as-library", "-target", "arm64-apple-macosx13.5",
        "scripts/audio-listener-probe/Decode.swift", "scripts/audio-listener-probe/DecodeReference.swift",
        "scripts/audio-listener-probe/decode-fixture.swift", "scripts/audio-listener-probe/decode-media-fixture.swift",
        "scripts/audio-listener-probe/decode-fractional-fixture.swift",
        "-o", binary], { encoding: "utf8", timeout: 60000 });
    assert.ifError(build.error);
    assert.equal(build.status, 0, build.stderr);
    for (const mode of [
        "reference-offset-trim", "reference-contiguous", "reference-gap", "reference-scaled",
        "reference-empty", "reference-missing", "reference-incomplete", "reference-invalid",
        "reference-indefinite", "reference-too-long", "reference-zero",
        "frames-aac-priming", "frames-pcm", "frames-120", "frames-121", "frames-zero",
        "frames-bad-rate", "frames-negative-priming", "frames-trimmed", "frames-too-short", "frames-invalid-time",
        "frames-table-valid", "frames-table-overflow", "frames-table-mismatch", "frames-table-wrong-valid", "frames-table-negative",
        "video-longer", "video-inconsistent",
        "media-fractional-pcm-48000", "media-fractional-pcm-44100", "media-fractional-pcm-96000",
        "media-fractional-aac-48000", "media-fractional-aac-44100", "media-fractional-aac-stereo-48000",
        "rounding-up", "rounding-excess", "rounding-minimum", "rounding-deficit",
        "complete", "retry-second", "retry-third", "exhaust", "exhaust-120", "minor-six",
        "tolerance-edge", "outside-tolerance", "overlong", "overlong-one-frame", "empty", "odd", "io-error",
        "cancel-before", "cancel-after", "existing", "destination-race",
    ]) {
        await t.test(mode, () => {
            const directory = join(run, mode);
            mkdirSync(directory);
            const result = spawnSync(binary, [mode, directory], { encoding: "utf8", timeout: 15000 });
            assert.ifError(result.error);
            assert.equal(result.status, 0, result.stderr);
            if (mode === "video-longer" || mode.startsWith("media-fractional-")) {
                assert.ok(result.stdout.endsWith('{"verified":true}'));
            } else {
                assert.deepEqual(JSON.parse(result.stdout), { verified: true });
            }
        });
    }
});
