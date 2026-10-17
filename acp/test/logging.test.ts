import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PixFileLogger } from "../../dist/app/logger.js";
import { createLogger, withPixLogContext } from "../src/logging.js";

test("ACP stderr and files preserve per-operation context without transcripts or credentials", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pix-acp-log-"));
	try {
		const file = new PixFileLogger({ directory, source: "acp", level: "debug" });
		const stderr: string[] = [];
		const logger = createLogger("debug", line => stderr.push(line), file);
		await Promise.all(["first", "second"].map(project => withPixLogContext({ project: `/projects/${project}`, sessionId: project }, async () => {
			await Promise.resolve();
			logger.warn(`failed Bearer private-${project}`, { module: "session" });
		})));
		logger.debug("global");
		await file.flush();
		const text = (await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name), "utf8")))).join("");
		const records = text.trim().split("\n").map(line => JSON.parse(line));
		assert.equal(records.length, 3);
		for (const name of ["first", "second"]) {
			const row = records.find(row => row.sessionId === name);
			assert.deepEqual(row.project, { name, path: `/projects/${name}` });
			assert.equal(row.source, "acp");
			assert.equal(row.module, "session");
		}
		assert.equal(records.find(row => row.level === "debug").project, null);
		assert.doesNotMatch(text + stderr.join("\n"), /private-first|private-second/);
		assert.equal(stderr.length, 3);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("ACP remains stderr-only when file storage fails", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pix-acp-log-failure-"));
	try {
		const filePath = join(directory, "blocked");
		await writeFile(filePath, "not a directory");
		const file = new PixFileLogger({ directory: filePath, source: "acp" });
		const stderr: string[] = [];
		createLogger("info", line => stderr.push(line), file).error("still visible");
		await file.flush();
		assert.equal(file.dropped, 1);
		assert.match(stderr[0]!, /still visible/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("stderr mirroring stops quietly once the host closes the pipe", async () => {
	const { writeDiagnosticLine, isClosedPipeError } = await import("../src/logging.js");
	let closed = 0;
	const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
	const throwing = { writable: true, write: () => { throw epipe; } } as unknown as NodeJS.WritableStream;
	assert.doesNotThrow(() => writeDiagnosticLine(throwing, "line", () => { closed += 1; }));
	assert.equal(closed, 1);
	const destroyed = { destroyed: true, write: () => assert.fail("must not write") } as unknown as NodeJS.WritableStream;
	writeDiagnosticLine(destroyed, "line", () => { closed += 1; });
	assert.equal(closed, 2);
	const other = { writable: true, write: () => { throw new TypeError("boom"); } } as unknown as NodeJS.WritableStream;
	assert.throws(() => writeDiagnosticLine(other, "line", () => {}), /boom/);
	assert.equal(isClosedPipeError({ code: "ERR_STREAM_DESTROYED" }), true);
	assert.equal(isClosedPipeError(new Error("x")), false);
});
