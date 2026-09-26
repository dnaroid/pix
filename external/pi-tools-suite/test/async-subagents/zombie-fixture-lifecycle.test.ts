import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { finishFixture, observeInput } from "./zombie-fixture-lifecycle.js";

test("early closed stdin/EPIPE is observed by both the stream and write callback", async () => {
	const stream = new PassThrough();
	const input = observeInput(stream);
	stream.destroy(Object.assign(new Error("early child exit"), { code: "EPIPE" }));
	input.write("r");
	input.end();
	await new Promise((resolve) => setImmediate(resolve));
	expect(input.errors.some((error) => (error as NodeJS.ErrnoException).code === "EPIPE")).toBe(true);
	expect(input.errors.length).toBeGreaterThanOrEqual(2); // error event and failed write callback
});

test("unconfirmed close retains binary directory even after direct-child backstop", async () => {
	const dir = mkdtempSync(join(tmpdir(), "zombie-close-test-"));
	let killed = 0;
	try {
		await expect(finishFixture(dir, new Promise(() => {}), { kill: () => { killed++; return true; } }, 1, false))
			.rejects.toThrow(`retained fixture directory: ${dir}`);
		expect(killed).toBe(1);
		expect(existsSync(dir)).toBe(true);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("direct Q close without K completion retains binary directory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "zombie-close-test-"));
	try {
		await expect(finishFixture(dir, Promise.resolve(), { kill: () => { throw new Error("unexpected kill"); } }, 1, false))
			.rejects.toThrow(`native K completion unconfirmed; retained fixture directory: ${dir}`);
		expect(existsSync(dir)).toBe(true);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
