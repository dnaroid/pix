import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

// Exercise the actual delegate/cancel latch without AVFoundation or a device.
test("microphone completion ordering without capture", { skip: process.platform !== "darwin" }, async (t) => {
	mkdirSync(".pi/artifacts", { recursive: true });
	const run = mkdtempSync(resolve(".pi/artifacts/listener-completion-tests-"));
	const driver = join(run, "Driver.swift");
	const binary = join(run, "completion-test");
	writeFileSync(driver, `
import Foundation
enum FixtureFailure: Error { case interrupted }
@main struct Driver {
    @MainActor static func main() async throws {
        let mode = CommandLine.arguments[1]
        let completion = CaptureCompletion()
        let expectedCancellation = mode.hasPrefix("cancel")
        let expectedFailure = mode == "error-while-waiting"
        let resolve = {
            if expectedCancellation {
                completion.resolve(.failure(CancellationError()))
                completion.resolve(.success(())) // Stale finish cannot revive a cancelled capture.
            } else if expectedFailure {
                completion.resolve(.failure(FixtureFailure.interrupted))
                completion.resolve(.success(()))
            } else {
                completion.resolve(.success(()))
                completion.resolve(.failure(CancellationError()))
            }
        }
        if mode.hasSuffix("before-wait") {
            resolve()
        } else {
            // This actor task cannot run until main suspends in wait(), so the
            // continuation-first path is deterministic, not a timed sleep.
            Task { @MainActor in resolve() }
        }
        do {
            try await completion.wait()
            guard !expectedCancellation && !expectedFailure else { exit(1) }
        } catch is CancellationError {
            guard expectedCancellation else { exit(1) }
        } catch FixtureFailure.interrupted {
            guard expectedFailure else { exit(1) }
        }
        completion.resolve(.success(())) // Duplicate callback must not resume twice.
    }
}
`);
	const build = spawnSync("xcrun", ["swiftc", "-parse-as-library", "-target", "arm64-apple-macosx13.5",
		"scripts/audio-listener-probe/CaptureCompletion.swift", driver, "-o", binary], { encoding: "utf8", timeout: 60000 });
	assert.ifError(build.error);
	assert.equal(build.status, 0, build.stderr);
	for (const mode of ["cancel-before-wait", "success-before-wait", "cancel-while-waiting", "success-while-waiting", "error-while-waiting"]) {
		await t.test(mode, () => {
			const result = spawnSync(binary, [mode], { encoding: "utf8", timeout: 5000 });
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
		});
	}
});
