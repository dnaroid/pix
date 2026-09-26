import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeWithin, finishFixture, observeInput } from "./zombie-fixture-lifecycle.js";

// Direct native Q child only. Never signal the captured A/K PIDs or -A.
async function scenario(earlyEof: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "session-only-anchor-"));
	let spawned = false;
	try {
		const binary = join(dir, "discriminator");
		const source = fileURLToPath(new URL("./fixtures/session-only-anchor.c", import.meta.url));
		execFileSync("cc", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror", "-o", binary, source], { timeout: 5000 });
		const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
		spawned = true;
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
			if (earlyEof) input.end();
			const deadline = Date.now() + 8000;
			while (!stdout.includes("probe signal0 return=") && child.exitCode === null && !spawnError && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 10));
			if (stdout.includes("probe signal0 return=") && !earlyEof) input.write("r");
			else input.end();
			if (!await closeWithin(close, 14000)) throw new Error("native Q exceeded 14s");
			const result = await close;
			console.log(`native session-only anchor (early EOF=${earlyEof}):\n${stdout.trim()}\nstderr=${stderr.trim()} exit=${result.code} signal=${result.signal}`);
			if (spawnError) throw spawnError;
			const topology = stdout.match(/topology a=(\d+) k=(\d+) a_group=\1 k_group=\2 k_session=\1 observed_k_session=\1/);
			completionConfirmed = topology !== null && stdout.includes(
				`keeper_completion k=${topology[2]} group=${topology[2]} session=${topology[1]} eof=1`,
			);
			if (input.errors.length) throw new Error(`native stdin failed: ${input.errors.map(String).join("; ")}`);
			expect(stdout).toMatch(/topology a=(\d+) k=(\d+) a_group=\1 k_group=\2 k_session=\1 observed_k_session=\1/);
			expect(stdout).toContain("a_reaped=1 a_exit=0");
			expect(stdout).toMatch(/probe signal0 return=-1 errno=3(?:\n|$)/); // Darwin ESRCH
			expect(stdout).toMatch(/keeper_completion k=\d+ group=\d+ session=\d+ eof=1/);
			expect(result).toEqual({ code: 0, signal: null });
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
		if (!spawned) rmSync(dir, { recursive: true, force: true });
	}
}

test.skipIf(process.platform !== "darwin")("reaped A has absent PGID while live K retains A's session until explicit release", () => scenario(false), 30000);
test.skipIf(process.platform !== "darwin")("owner-input EOF still probes before K completes", () => scenario(true), 30000);
