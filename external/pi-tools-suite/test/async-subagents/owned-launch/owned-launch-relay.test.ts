import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedLaunchNativeDir } from "../../../src/async-subagents/core/owned-launch/bootstrap.js";

// Real pipes/sockets and production relay code, but no launchd jobs or provider.
test.skipIf(process.platform !== "darwin")("relay preserves stdout/stderr under HUP backpressure and observes owner EOF", () => {
	const dir = mkdtempSync(join(tmpdir(), "owned-relay-test-"));
	try {
		const exe = join(dir, "relay-test");
		const build = spawnSync("xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror",
			"-I", ownedLaunchNativeDir(), join(import.meta.dir, "fixtures", "owned-launch-relay-hup.c"), "-lbsm", "-o", exe],
		{ encoding: "utf8", timeout: 15000 });
		expect(build.status, build.stderr).toBe(0);
		for (const mode of ["backpressure-hup", "stderr-backpressure-hup", "stdin-hup"]) {
			const run = spawnSync(exe, [mode], { encoding: "utf8", timeout: 40000 });
			expect(run.status, `${mode}: ${run.error ?? ""} ${run.stderr}`).toBe(0);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 140000);
