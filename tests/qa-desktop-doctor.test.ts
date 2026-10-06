// @ts-nocheck -- injectable project Node scripts, no real installation or TCC calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArguments, runCli } from "../scripts/qa-desktop/cli.mjs";
import { doctorDesktop } from "../scripts/qa-desktop/doctor.mjs";

const granted = "accessibility=granted\nscreen_recording=granted\nsck=available\n";
const missing = "accessibility=missing\nscreen_recording=missing\nsck=available\n";

function dependencies(stdout = granted) {
	const calls = [];
	return { calls, bundled: async () => null,
		prepare: async (context) => { calls.push(["prepare", context]); return "/private/user/Library/Application Support/Pix/ui-qa/helpers/macos-accessibility"; },
		run: async (...args) => { calls.push(["run", ...args]); return { code: 0, stdout, stderr: "" }; } };
}

test("doctor accepts only an explicit single --prompt flag", () => {
	assert.deepEqual(parseArguments(["doctor"]), { command: "doctor" });
	assert.deepEqual(parseArguments(["doctor", "--prompt"]), { command: "doctor", prompt: true });
	for (const args of [["doctor", "--prompt", "--prompt"], ["doctor", "--manifest", "/tmp/m"], ["doctor", "--prompt=true"], ["prepare", "--prompt"], ["launch", "--manifest", "/tmp/m", "--prompt"]]) assert.throws(() => parseArguments(args));
});

test("doctor uses the normal helper preparation without a watcher, profile or permission prompt", async () => {
	const deps = dependencies();
	const result = await doctorDesktop({ checkout: "/project" }, deps);
	assert.equal(result.code, 0);
	assert.equal(deps.calls[0][0], "prepare");
	assert.equal(deps.calls[0][1].projectRoot, "/project");
	assert.equal(deps.calls[0][1].source.endsWith("/drivers/macos/macos-accessibility.swift"), true);
	assert.deepEqual(deps.calls[1].slice(1, 3), [result.helperPath, ["doctor"]]);
});

test("explicit permission request calls only doctor --prompt; missing is not a pass", async () => {
	const deps = dependencies(missing);
	assert.equal((await doctorDesktop({ checkout: "/project", prompt: true }, deps)).code, 2);
	assert.deepEqual(deps.calls[1][2], ["doctor", "--prompt"]);
	const noPrompt = dependencies();
	await doctorDesktop({ checkout: "/project", prompt: "yes" }, noPrompt);
	assert.deepEqual(noPrompt.calls[1][2], ["doctor"]);
});

test("release helper takes precedence; broken release never falls back to a dev install", async () => {
	const deps = dependencies();
	deps.bundled = async () => "/release/helpers/macos-accessibility";
	const result = await doctorDesktop({ checkout: "/project" }, deps);
	assert.equal(result.helperPath, "/release/helpers/macos-accessibility");
	assert.equal(deps.calls.length, 1);
	deps.bundled = async () => { throw new Error("invalid release signature"); };
	await assert.rejects(doctorDesktop({ checkout: "/project" }, deps), /invalid release signature/);
	assert.equal(deps.calls.length, 1);
});

test("failed, invalid and timed-out doctors fail closed", async () => {
	const deps = dependencies("window exists");
	await assert.rejects(doctorDesktop({ checkout: "/project" }, deps), /invalid permission status/);
	deps.run = async () => ({ code: 1, stdout: "", stderr: "doctor failed" });
	await assert.rejects(doctorDesktop({ checkout: "/project" }, deps), /doctor failed/);
	let ticks = 0;
	deps.now = () => ticks++ ? 100_000 : 0;
	deps.run = async () => assert.fail("must not execute after deadline");
	await assert.rejects(doctorDesktop({ checkout: "/project" }, deps), /timed out/);
});

test("CLI routes doctor without preparing or launching Desktop and returns permission status", async () => {
	const result = await runCli(["doctor", "--prompt"], "/project", { platform: "darwin",
		doctor: async (options) => { assert.equal(options.prompt, true); return { helperPath: "/helper", output: missing, code: 2 }; },
		prepare: async () => assert.fail("no app preparation"), launch: async () => assert.fail("no app launch") });
	assert.equal(result, 2);
});
