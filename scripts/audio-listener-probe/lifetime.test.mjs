import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

// Exercise the real lifetime controller without ScreenCaptureKit, permission
// requests, media, or timing-dependent sleep-before-cancel tests.
test("native capture lifetime without capture", { skip: process.platform !== "darwin" }, async (t) => {
	mkdirSync(".pi/artifacts", { recursive: true });
	const run = mkdtempSync(resolve(".pi/artifacts/listener-lifetime-tests-"));
	const driver = join(run, "Driver.swift");
	const binary = join(run, "lifetime-test");
	writeFileSync(driver, `
import Foundation
// The consent helper's error type belongs to the probe entrypoint, omitted here.
struct ProbeFailure: Error { init(_ message: String) {} }
@main struct Driver {
    static func main() async throws {
        let mode = CommandLine.arguments[1]
        let partial = URL(fileURLWithPath: CommandLine.arguments[2])
        let lifetime = CaptureLifetime(seconds: 5, partial: partial,
            deadline: mode == "deadline" ? .now() : nil)
        defer { lifetime.close() }
        switch mode {
        case "before-start":
            lifetime.cancel()
            let task = lifetime.start { fatalError("cancelled task ran") }
            do { try await task.value; exit(1) } catch is CancellationError {}
        case "before-publish":
            lifetime.cancel()
            do { try lifetime.publish { fatalError("cancelled result published") }; exit(1) }
            catch is CancellationError {}
        case "after-commit":
            try lifetime.publish {}
            lifetime.cancel()
            lifetime.terminate() // An already queued deadline must not kill a committed result.
            try lifetime.checkActive()
        case "maximum-duration":
            guard CaptureLifetime.watchdogSeconds(for: 120) == 135 else { exit(1) }
        case "close-late-callbacks":
            lifetime.close()
            lifetime.cancel()
            lifetime.cancel()
            lifetime.terminate() // A queued deadline cannot kill a closed owner.
        case "close-before-start":
            lifetime.close()
            let task = lifetime.start { fatalError("closed task ran") }
            do { try await task.value; exit(1) } catch is CancellationError {}
        case "close-before-publish":
            lifetime.close()
            do { try lifetime.publish { fatalError("closed result published") }; exit(1) }
            catch is CancellationError {}
        case "close-running":
            // Wait until the owned task has entered its operation, without sleeps.
            var task: Task<Void, Error>?
            await withCheckedContinuation { (started: CheckedContinuation<Void, Never>) in
                task = lifetime.start {
                    started.resume()
                    try await Task.sleep(nanoseconds: 10_000_000_000)
                }
            }
            lifetime.close()
            do { try await task!.value; exit(1) } catch is CancellationError {}
        case "double-cancel":
            lifetime.cancel()
            lifetime.cancel()
            exit(1)
        case "deadline":
            try await Task.sleep(nanoseconds: 10_000_000_000)
            exit(1)
        default: exit(2)
        }
    }
}
`);
	const build = spawnSync("xcrun", ["swiftc", "-parse-as-library", "-target", "arm64-apple-macosx13.5",
		"scripts/audio-listener-probe/CaptureLifetime.swift", driver, "-o", binary], { encoding: "utf8", timeout: 60000 });
	assert.ifError(build.error);
	assert.equal(build.status, 0, build.stderr);
	for (const mode of ["before-start", "before-publish", "after-commit", "maximum-duration", "close-late-callbacks", "close-before-start", "close-before-publish", "close-running", "double-cancel", "deadline"]) {
		await t.test(mode, () => {
			const partial = join(run, `${mode}.partial`);
			writeFileSync(partial, "private partial fixture", { mode: 0o600 });
			const result = spawnSync(binary, [mode, partial], { encoding: "utf8", timeout: 5000 });
			assert.ifError(result.error);
			const hardStop = mode === "double-cancel" || mode === "deadline";
			assert.equal(result.status, hardStop ? 124 : 0, result.stderr);
			if (hardStop) assert.equal(existsSync(partial), false);
		});
	}
});
