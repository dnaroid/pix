import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { commandExists, runProcess } from "../src/app/process.js";

describe("process helpers", () => {
	it("captures stdout, stderr, status, and bounded output", async () => {
		const result = await runProcess(process.execPath, ["-e", "process.stdout.write('abcdef'); process.stderr.write('err'); process.exit(7)"], { maxBufferBytes: 3 });

		assert.equal(result.status, 7);
		assert.equal(result.signal, null);
		assert.equal(result.stdout, "def");
		assert.equal(result.stderr, "err");
	});

	it("passes stdin and reports spawn errors/timeouts", async () => {
		const echoed = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "hello" });
		assert.equal(echoed.stdout, "hello");

		const missing = await runProcess("definitely-not-a-pix-command", []);
		assert.notEqual(missing.status, 0);
		assert.ok(missing.error);

		const timedOut = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { timeoutMs: 20 });
		assert.equal(timedOut.timedOut, true);
	});

	it("checks command availability and safely quotes command names", async () => {
		const root = mkdtempSync(join(tmpdir(), "pix-command-exists-"));
		try {
			assert.equal(await commandExists("sh"), true);
			assert.equal(await commandExists("missing", { PATH: root }), false);
			assert.equal(await commandExists("missing'quoted", { PATH: root }), false);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});
});
