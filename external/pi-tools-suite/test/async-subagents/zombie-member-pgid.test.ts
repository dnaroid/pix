import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeWithin, finishFixture, observeInput } from "./zombie-fixture-lifecycle.js";

// Test-only macOS discriminator. Only the native Q binary probes its captured
// group, and only with signal 0. The runner may kill its owned direct Q child
// as a timeout backstop; it never signals a recorded PID or process group.
async function scenario(eofBeforeProbe: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "zombie-member-pgid-"));
	let handedToCleanup = false;
	try {
		const binary = join(dir, "discriminator");
		const source = fileURLToPath(new URL("./fixtures/zombie-member-pgid.c", import.meta.url));
		execFileSync("cc", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror", "-o", binary, source], { timeout: 5000 });
		const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
		handedToCleanup = true;
		const input = observeInput(child.stdin);
		let stdout = "";
		let stderr = "";
		let spawnError: Error | undefined;
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			child.once("error", (error: Error) => { spawnError = error; });
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		let primary: unknown;
		let completionConfirmed = false;
		try {
			if (eofBeforeProbe) input.end();
			const deadline = Date.now() + 8000;
			while (!stdout.includes("after_probe_k_alive=") && child.exitCode === null && !spawnError && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 10));
			if (stdout.includes("after_probe_k_alive=") && !eofBeforeProbe) input.write("r");
			else input.end();
			if (!await closeWithin(close, 14000)) throw new Error("native owner exceeded 14s");
			const result = await close;
			console.log(`native zombie-member host observation (early EOF=${eofBeforeProbe}):\n${stdout.trim()}\nstderr=${stderr.trim()} exit=${result.code} signal=${result.signal}`);
			if (spawnError) throw spawnError;
			expect(result).toEqual({ code: 0, signal: null });
			if (input.errors.length) throw new Error(`native stdin failed: ${input.errors.map(String).join("; ")}`);
			expect(stdout).toContain("a_reaped=1 a_exit=0 k_alive=1");
			expect(stdout).toContain("after_probe_k_alive=1");
			expect(stdout).toMatch(/probe signal0 signal=0 return=-1 errno=1(?:\n|$)/); // Darwin EPERM
			expect(stdout).not.toContain("probe SIGTERM");
			expect(stdout).not.toContain("probe SIGKILL");
			expect(stdout).toMatch(/z_second_wait_return=0 errno=0 pid=\d+ status=7 k_group=\d+ z_reap=\d+ reap_errno=0/);
			expect(stdout).toContain("k_completion_eof=1");
			completionConfirmed = true;
		} catch (error) {
			primary = error;
			if (error instanceof Error && input.errors.length && !error.message.includes("native stdin failed"))
				error.message += `; native stdin errors: ${input.errors.map(String).join("; ")}`;
			throw error;
		} finally {
			input.end();
			try { await finishFixture(dir, close, child, 2000, completionConfirmed); }
			catch (cleanupError) {
				if (primary instanceof Error) primary.message += `; ${String(cleanupError)}`;
				else throw cleanupError;
			}
		}
	} finally {
		// Compilation failure has no running binary. After spawn, only confirmed
		// child close permits deletion (finishFixture owns that decision).
		if (!handedToCleanup) rmSync(dir, { recursive: true, force: true });
	}
}

test.skipIf(process.platform !== "darwin")("reaped detached A with a waitable zombie member in A's group", () => scenario(false), 30000);
test.skipIf(process.platform !== "darwin")("runner EOF before signal 0 still leaves Z held through Q's probe and reaped afterward", () => scenario(true), 30000);
