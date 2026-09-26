import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localNode, rpcProbe, stopAndConfirm } from "./provider-offline-rpc.ts";

test("Node lookup never loads inherited NODE_OPTIONS", () => {
	const work = mkdtempSync(join(tmpdir(), "offline-node-probe-"));
	const before = process.env.NODE_OPTIONS;
	try {
		const preload = join(work, "preload.cjs");
		writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(join(work, "loaded"))}, 'yes')`);
		process.env.NODE_OPTIONS = `--require=${preload}`;
		expect(existsSync(localNode())).toBe(true);
		expect(existsSync(join(work, "loaded"))).toBe(false);
	} finally {
		if (before === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = before;
		rmSync(work, { recursive: true, force: true });
	}
});

test("early exit and stdin EPIPE reject the RPC wait; close precedes workdir cleanup", async () => {
	const node = localNode();
	for (const script of ["process.exit(3)", "setTimeout(() => process.exit(3), 1000)"]) {
		const work = mkdtempSync(join(tmpdir(), "offline-early-exit-"));
		try {
			const child = spawn(node, ["-e", script], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "", LANG: "C" } });
			const close = new Promise<void>((resolve) => child.once("close", () => resolve()));
			const probe = rpcProbe(child, 1000);
			if (script.includes("1000")) child.stdin!.destroy(Object.assign(new Error("simulated broken pipe"), { code: "EPIPE" }));
			await expect(probe).rejects.toThrow();
			await stopAndConfirm(child, close, work);
			await close;
		} finally { rmSync(work, { recursive: true, force: true }); }
	}
}, 5000);

test("fake request self-watchdog records its exit without Pi; missing exit marker retains HOME", async () => {
	const work = mkdtempSync(join(tmpdir(), "offline-fake-watchdog-"));
	const node = localNode();
	let guard: ReturnType<typeof setTimeout> | undefined;
	try {
		await expect(stopAndConfirm(undefined, undefined, work, 40, 1)).rejects.toThrow("retaining offline workdir");
		const fixture = fileURLToPath(new URL("./fixtures/provider-offline-cli.mjs", import.meta.url));
		const child = spawn(node, [fixture, "--input-format", "stream-json", "--output-format", "stream-json"], {
			stdio: ["pipe", "pipe", "pipe"], env: { HOME: work, PATH: "", PI_OFFLINE_FAKE_WATCHDOG_MS: "80" },
		});
		const close = new Promise<void>((resolve) => child.once("close", () => resolve()));
		// Independent test backstop: a broken self-watchdog must not leak this child.
		guard = setTimeout(() => child.kill("SIGKILL"), 1500);
		await close;
		clearTimeout(guard);
		await stopAndConfirm(child, close, work, 200, 1);
		const marker = readdirSync(work).find((name) => name.startsWith("fake-actor-"))!;
		expect(JSON.parse(readFileSync(join(work, marker), "utf8"))).toMatchObject({ exited: true, code: 124 });
		writeFileSync(join(work, "fake-actor-unfinished.json"), JSON.stringify({ pid: 1, nonce: "unfinished", exited: false }));
		await expect(stopAndConfirm(undefined, undefined, work, 40)).rejects.toThrow("retaining offline workdir");
		expect(existsSync(work)).toBe(true);
	} finally { clearTimeout(guard); rmSync(work, { recursive: true, force: true }); }
}, 5000);
