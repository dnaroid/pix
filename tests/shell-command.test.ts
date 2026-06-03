import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";

import {
	bangShellCommandFromInput,
	formatShellCommandEntry,
	runChatShellCommand,
	runInteractiveShellCommand,
	setShellCommandTestDeps,
	shellCommandFromBangInput,
} from "../src/app/commands/shell-command.js";

type FakeChildProcess = EventEmitter & {
	killed: boolean;
	pid?: number;
	stdout: PassThrough;
	stderr: PassThrough;
	stdin: Writable;
	stdinText: string;
	stdinEnded: boolean;
	kill(signal?: NodeJS.Signals): boolean;
};

describe("shell command helpers", () => {
	it("parses bang-prefixed chat and interactive commands", () => {
		assert.equal(bangShellCommandFromInput("hello"), undefined);
		assert.deepEqual(bangShellCommandFromInput(" ! echo hi "), { command: "echo hi", interactive: false });
		assert.deepEqual(bangShellCommandFromInput("!! npm test"), { command: "npm test", interactive: true });
		assert.equal(shellCommandFromBangInput("  !pwd"), "pwd");
	});

	it("streams chat shell output and settles once", async () => {
		const child = fakeChild(1234);
		const restore = setShellCommandTestDeps({ spawn: (() => child) as never });
		const output: string[] = [];
		const settled: unknown[] = [];
		try {
			const running = runChatShellCommand("echo hi", "/repo", {
				onOutput: (chunk, stream) => output.push(`${stream}:${chunk}`),
				onSettled: (result) => settled.push(result),
			});

			assert.equal(running.pid, 1234);
			child.stdout.emit("data", "hello");
			child.stderr.emit("data", "warn");
			assert.equal(running.writeInput("stdin"), true);
			running.endInput();
			child.emit("close", 7, null);
			child.emit("error", new Error("ignored after close"));

			assert.deepEqual(output, ["stdout:hello", "stderr:warn"]);
			assert.deepEqual(await running.done, { exitCode: 7, signal: null });
			assert.deepEqual(settled, [{ exitCode: 7, signal: null }]);
			assert.equal(child.stdinText, "stdin");
			assert.equal(child.stdinEnded, true);
		} finally {
			restore();
		}
	});

	it("handles chat spawn failures and unwritable stdin", async () => {
		const restore = setShellCommandTestDeps({ spawn: (() => { throw new Error("no shell"); }) as never });
		try {
			let settled: unknown;
			const running = runChatShellCommand("bad", "/repo", { onSettled: (result) => { settled = result; } });
			assert.equal(running.writeInput("x"), false);
			assert.equal(running.interrupt(), false);
			assert.equal(running.kill(), false);
			running.endInput();
			assert.deepEqual(await running.done, { exitCode: null, signal: null, error: "no shell" });
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(settled, { exitCode: null, signal: null, error: "no shell" });
		} finally {
			restore();
		}
	});

	it("runs interactive commands with mocked spawn, stdout, and return prompt", async () => {
		const child = fakeChild();
		const stdout: string[] = [];
		const originalWrite = process.stdout.write;
		const restore = setShellCommandTestDeps({ spawn: (() => child) as never, waitForReturnToPix: async () => { stdout.push("waited"); } });
		try {
			process.stdout.write = ((chunk: unknown) => {
				stdout.push(String(chunk));
				return true;
			}) as never;
			const resultPromise = runInteractiveShellCommand("npm test", "/repo");
			child.emit("close", null, "SIGTERM");

			assert.deepEqual(await resultPromise, { exitCode: null, signal: "SIGTERM" });
			assert.deepEqual(stdout, ["\n$ npm test\n\n", "\n[pix] terminated by SIGTERM\n", "waited"]);
		} finally {
			process.stdout.write = originalWrite;
			restore();
		}
	});

	it("formats shell command entry outcomes", () => {
		assert.equal(formatShellCommandEntry("build", { exitCode: 0, signal: null }), "Shell command finished (exit 0): !build");
		assert.equal(formatShellCommandEntry("serve", { exitCode: null, signal: null, error: "spawn failed" }, "!!"), "Shell command failed to start: !!serve\nspawn failed");
	});
});

function fakeChild(pid?: number): FakeChildProcess {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let stdinText = "";
	let stdinEnded = false;
	const stdin = new Writable({
		write(chunk, _encoding, callback) {
			stdinText += chunk.toString();
			callback();
		},
	});
	const child = new EventEmitter() as FakeChildProcess;
	if (pid !== undefined) child.pid = pid;
	child.killed = false;
	child.stdout = stdout;
	child.stderr = stderr;
	child.stdin = stdin;
	child.kill = () => {
		child.killed = true;
		return true;
	};
	Object.defineProperty(child, "stdinText", { get: () => stdinText });
	Object.defineProperty(child, "stdinEnded", { get: () => stdinEnded });
	const originalEnd = stdin.end.bind(stdin);
	stdin.end = ((...args: unknown[]) => {
		stdinEnded = true;
		return originalEnd(...args as []);
	}) as never;
	return child;
}
