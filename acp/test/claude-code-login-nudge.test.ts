import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { spawn } from "node:child_process";
import { launchClaudeCodeLoginNudge, restrictedClaudeChildEnv } from "../src/acp/claude-code-login-nudge.js";

test("Claude child receives only allowlisted host variables and discards all output", async () => {
	const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
	child.kill = () => true;
	let options: Parameters<typeof spawn>[2];
	const pending = launchClaudeCodeLoginNudge({
		env: restrictedClaudeChildEnv({ PATH: "/bin", HOME: "/home/me", ANTHROPIC_API_KEY: "secret" }),
		spawnImpl: ((_command: string, _args: string[], config: Parameters<typeof spawn>[2]) => {
			options = config;
			return child;
		}) as typeof spawn,
	});
	assert.equal(options!.stdio, "ignore");
	assert.equal(options!.env?.PATH, "/bin");
	assert.equal(options!.env?.ANTHROPIC_API_KEY, undefined);
	child.emit("close", 0);
	assert.equal(await pending, true);
});

test("headless nudge terminates and escalates a stuck child", async () => {
	const signals: string[] = [];
	const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
	child.kill = (signal) => {
		signals.push(signal);
		return true;
	};
	const pending = launchClaudeCodeLoginNudge({
		timeoutMs: 5,
		killGraceMs: 5,
		spawnImpl: (() => child) as unknown as typeof spawn,
	});
	assert.equal(await pending, true);
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	// A broken wrapper never sends close; the request still completes on time.
});

test("missing Claude executable is an ordinary launch failure", async () => {
	const child = new EventEmitter();
	const pending = launchClaudeCodeLoginNudge({ spawnImpl: (() => child) as unknown as typeof spawn });
	child.emit("error", new Error("ENOENT"));
	assert.equal(await pending, false);
});
