import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

// Actual permission/lifetime code with a fake OS callback: no TCC or devices.
test("permission wait and capture watchdog without devices", { skip: process.platform !== "darwin" }, async (t) => {
	mkdirSync(".pi/artifacts", { recursive: true });
	const run = mkdtempSync(resolve(".pi/artifacts/listener-permission-tests-"));
	const driver = join(run, "Driver.swift");
	const binary = join(run, "permission-test");
	writeFileSync(driver, `
import Foundation
struct ProbeFailure: Error { init(_ message: String) {} }
@MainActor final class FakePermission {
    var reply: ((Bool) -> Void)?
    var requested = false
    var captured = false
}
@main struct Driver {
    @MainActor static func main() async throws {
        let mode = CommandLine.arguments[1]
        let partial = URL(fileURLWithPath: CommandLine.arguments[2])
        // An already expired deadline must not run during user deliberation.
        let lifetime = CaptureLifetime(seconds: 1, partial: partial,
            deadline: .now(), awaitingPermission: true)
        defer { lifetime.close() }
        let fake = FakePermission()
        if mode == "cancel-before-request" {
            lifetime.cancel()
            let task = lifetime.start {
                try await awaitCapturePermission { _ in fatalError("cancelled request ran") }
            }
            do { try await task.value; exit(1) } catch is CancellationError {}
            return
        }
        var task: Task<Void, Error>!
        await withCheckedContinuation { (requested: CheckedContinuation<Void, Never>) in
            task = lifetime.start {
                try await awaitCapturePermission { reply in
                    fake.requested = true
                    fake.reply = reply
                    requested.resume()
                    if mode == "synchronous-grant" { reply(true) }
                }
                try lifetime.armWatchdog(deadline: mode == "grant-deadline" ? .now() : nil)
                await MainActor.run { fake.captured = true }
                if mode == "grant-deadline" {
                    try await Task.sleep(nanoseconds: 10_000_000_000)
                }
            }
        }
        guard fake.requested else { exit(1) }
        switch mode {
        case "cancel-late-grant", "close-late-grant":
            if mode == "close-late-grant" { lifetime.close() } else { lifetime.cancel() }
            // Must finish before the OS supplies an answer at all.
            do { try await task.value; exit(1) } catch is CancellationError {}
            fake.reply?(true)
            fake.reply?(false)
            await Task.yield()
            guard !fake.captured else { exit(1) }
            do { try lifetime.armWatchdog(); exit(1) } catch is CancellationError {}
        case "deny":
            fake.reply?(false)
            do { try await task.value; exit(1) } catch is ProbeFailure {}
            guard !fake.captured else { exit(1) }
        case "grant-then-cancel":
            fake.reply?(true)
            lifetime.cancel() // The actor cannot process grant until we suspend.
            do { try await task.value; exit(1) } catch is CancellationError {}
            guard !fake.captured else { exit(1) }
        case "delayed-grant":
            // Give the real dispatch timer time to deliver the expired injected
            // deadline if mistakenly armed; this is not a device timing test.
            try await Task.sleep(nanoseconds: 100_000_000)
            guard !fake.captured else { exit(1) }
            fake.reply?(true)
            try await task.value
            guard fake.captured else { exit(1) }
        case "grant-deadline", "synchronous-grant":
            if mode == "grant-deadline" { fake.reply?(true) }
            try await task.value
            guard mode == "synchronous-grant", fake.captured else { exit(1) }
        default: exit(2)
        }
    }
}
`);
	const build = spawnSync("xcrun", ["swiftc", "-parse-as-library", "-target", "arm64-apple-macosx13.5",
		"scripts/audio-listener-probe/CaptureLifetime.swift", "scripts/audio-listener-probe/CaptureCompletion.swift",
		"scripts/audio-listener-probe/CapturePermission.swift", driver, "-o", binary], { encoding: "utf8", timeout: 60000 });
	assert.ifError(build.error);
	assert.equal(build.status, 0, build.stderr);
	for (const mode of ["cancel-before-request", "cancel-late-grant", "close-late-grant", "deny", "grant-then-cancel", "delayed-grant", "grant-deadline", "synchronous-grant"]) {
		await t.test(mode, () => {
			const partial = join(run, `${mode}.partial`);
			writeFileSync(partial, "private fixture", { mode: 0o600 });
			const result = spawnSync(binary, [mode, partial], { encoding: "utf8", timeout: 5000 });
			assert.ifError(result.error);
			assert.equal(result.status, mode === "grant-deadline" ? 124 : 0, result.stderr);
			if (mode === "grant-deadline") assert.equal(existsSync(partial), false);
		});
	}
});
