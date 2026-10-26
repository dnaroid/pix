import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { validateApplication, validateDesktopStepCapabilities } from "../../src/async-subagents/agents/ui-qa/backends/desktop.mjs";
import { textEditFixtureContract, runTextEditFixture, validateTextEditFixtureSteps, TEXTEDIT_EXECUTABLE } from "../../src/async-subagents/agents/ui-qa/backends/textedit-fixture.mjs";
import { createTextEditSupervisor } from "../../src/async-subagents/agents/ui-qa/backends/textedit-supervisor-client.mjs";

const smoke = { action: "texteditSmoke" };
const snapshot = { action: "snapshotAccessibility" };

describe("closed LaunchServices fixture contract", () => {
	test("does not produce argv, selectors, environment, or a PID capability", () => {
		for (const fixture of ["texteditBlank", "texteditBlankLifecycle"]) {
			expect(textEditFixtureContract({ fixture }, "darwin")).toBe(fixture);
			if (process.platform === "darwin") expect(validateApplication({ fixture }, process.cwd())).toEqual({ fixture });
		}
	});
	test("refuses other platforms, fixtures and injected parameters", () => {
		for (const platform of ["linux", "win32"] as const) expect(() => textEditFixtureContract({ fixture: "texteditBlank" }, platform)).toThrow();
		for (const fixture of ["TextEdit", "/bin/sh", true, null, ""]) expect(() => textEditFixtureContract({ fixture }, "darwin")).toThrow();
		for (const field of ["pid", "name", "bundleId", "launch", "env", "argv", "cwd", "extra"]) {
			expect(() => textEditFixtureContract({ fixture: "texteditBlank", [field]: "bad" }, "darwin")).toThrow(/cannot be combined/);
		}
	});
	test("keeps generic selector and external launch restrictions", () => {
		expect(textEditFixtureContract({ pid: 123 }, "darwin")).toBeUndefined();
		expect(validateApplication({ pid: 123 }, process.cwd())).toEqual({ selector: ["--pid", "123"], launch: undefined });
		for (const argv of [[TEXTEDIT_EXECUTABLE], ["/bin/sh", "-c", "true"], ["osascript", "-e", "x"]]) {
			expect(() => validateApplication({ launch: { argv } }, process.cwd())).toThrow(/project|shell|scripting/);
		}
	});
	test("allows one smoke or explicit zero-key lifecycle, with retained AX snapshots", () => {
		expect(() => validateTextEditFixtureSteps([snapshot, smoke, snapshot], "texteditBlank")).not.toThrow();
		expect(() => validateTextEditFixtureSteps([snapshot], "texteditBlankLifecycle")).not.toThrow();
		for (const steps of [[], [snapshot], [smoke, smoke]]) expect(() => validateTextEditFixtureSteps(steps, "texteditBlank")).toThrow();
		expect(() => validateTextEditFixtureSteps([smoke], "texteditBlankLifecycle")).toThrow();
	});
	test("fails closed for PID companions and generic mutations before launch", () => {
		for (const action of ["capture", "screenshot", "assertState", "pressKey", "inputText", "setValue", "activate", "activateWindow", "waitForWindow"]) {
			expect(() => validateTextEditFixtureSteps([smoke, { action }], "texteditBlank")).toThrow(/refuses action/);
		}
		for (const extra of [{ name: "../../escape" }, { depth: 5 }, { limit: 50 }, { timeoutMs: NaN }, { timeoutMs: 0 }]) {
			expect(() => validateTextEditFixtureSteps([smoke, { ...snapshot, ...extra }], "texteditBlank")).toThrow();
		}
	});
	test("smoke is unavailable for generic targets and requires keyboard capability", () => {
		expect(() => validateTextEditFixtureSteps([smoke], undefined)).toThrow(/requires the texteditBlank/);
		expect(() => validateDesktopStepCapabilities(smoke, [])).toThrow(/keyboardInput/);
		expect(validateDesktopStepCapabilities(smoke, ["keyboardInput"])).toBe(smoke);
	});
});

function fakeSupervisor(onCommand: (command: any, child: any) => void) {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
		pid: 999, kills: [] as string[],
		kill(this: any, signal: string) { this.kills.push(signal); this.emit("close", null, signal); return true; },
	});
	child.stdin.on("data", (data) => { for (const line of data.toString().trim().split("\n")) onCommand(JSON.parse(line), child); });
	const calls: any[] = [];
	const client = createTextEditSupervisor({ file: "/trusted/helper", argsPrefix: [] }, {
		cwd: "/project", releaseMs: 10,
		spawnProcess: ((...args: any[]) => { calls.push(args); return child; }) as any,
	});
	return { child, client, calls };
}
function respond(child: any, id: number, result: any, ok = true) {
	child.stdout.write(`${JSON.stringify({ id, ok, result })}\n`);
}

describe("private supervisor client (fake pipes only)", () => {
	test("launches only the helper and separates successful smoke from manual cleanup", async () => {
		const { client, child, calls } = fakeSupervisor(({ id, command }, child) => {
			if (command === "cleanup") { respond(child, id, { cleanup: "manualRequired" }); child.emit("close", 0); }
			else respond(child, id, { pidDiagnosticOnly: 42 });
		});
		expect(await client.request("launch", 100)).toEqual({ pidDiagnosticOnly: 42 });
		expect(await client.close()).toMatchObject({ cleanup: "manualRequired", helperReleased: true });
		expect(await client.close()).toMatchObject({ cleanup: "manualRequired" });
		expect(calls).toEqual([["/trusted/helper", ["textedit-supervisor"], { cwd: "/project", stdio: ["pipe", "pipe", "pipe"], detached: false }]]);
		expect(child.kills).toEqual([]);
		await expect(client.request("smoke", 100)).rejects.toThrow();
	});
	test("timeout revokes input, late callback cannot recover, only helper can be killed", async () => {
		const { client, child } = fakeSupervisor(() => {});
		await expect(client.request("launch", 1)).rejects.toThrow(/timeout/);
		respond(child, 1, { pidDiagnosticOnly: 42 });
		await expect(client.request("prepare", 100)).rejects.toThrow();
		expect(await client.close()).toMatchObject({ cleanup: "unknown", manualCloseRequired: true });
		expect(child.kills).toEqual(["SIGKILL"]);
	});
	test("observed exit is distinct from unknown crash", async () => {
		for (const cleanup of ["confirmed", "unknown", "notNeeded"]) {
			const { client, child } = fakeSupervisor(({ id }, child) => {
				respond(child, id, { cleanup }); child.emit("close", 0);
			});
			expect((await client.close()).cleanup).toBe(cleanup);
			expect(child.kills).toEqual([]);
		}
		const { client, child } = fakeSupervisor(() => {});
		const request = client.request("launch", 100);
		child.emit("close", 9);
		await expect(request).rejects.toThrow(/exited/);
		expect(await client.close()).toMatchObject({ cleanup: "unknown", manualCloseRequired: true });
	});
	test("cleanup cannot resolve a pending launch as success", async () => {
		const { client, child } = fakeSupervisor(() => {});
		const request = client.request("launch", 100);
		respond(child, 1, { cleanup: "manualRequired" });
		await expect(request).rejects.toThrow(/cleanup cannot resolve/);
		await expect(client.request("prepare", 100)).rejects.toThrow();
		child.emit("close", 0);
		expect(await client.close()).toMatchObject({ cleanup: "manualRequired", manualCloseRequired: true });
	});
	test("rejects malformed/oversized output and duplicate responses", async () => {
		for (const output of ["not json\n", `${"x".repeat(1024 * 1024 + 1)}\n`, '{"id":900,"ok":true,"result":{}}\n']) {
			const { client, child } = fakeSupervisor(() => {});
			const request = client.request("launch", 100);
			child.stdout.write(output);
			await expect(request).rejects.toThrow();
			await expect(client.request("smoke", 100)).rejects.toThrow();
			await client.close();
		}
		const { client, child } = fakeSupervisor(({ id }, child) => respond(child, id, {}));
		await client.request("launch", 100);
		respond(child, 1, {});
		await expect(client.request("prepare", 100)).rejects.toThrow();
		await client.close();
	});
	test("cancel, helper error and overlapping commands never restore permission", async () => {
		for (const mode of ["cancel", "error", "refusal"]) {
			const { client, child } = fakeSupervisor(() => {});
			const request = client.request("launch", 100);
			await expect(client.request("prepare", 100)).rejects.toThrow(/busy/);
			if (mode === "cancel") client.cancel("runner signal");
			else if (mode === "error") child.emit("error", new Error("spawn error"));
			else respond(child, 1, { error: "existing app" }, false);
			await expect(request).rejects.toThrow();
			await expect(client.request("smoke", 100)).rejects.toThrow();
			await client.close();
		}
	});
});

describe("fixture backend orchestration without UI", () => {
	test("stops at each refusal and always reports manual cleanup separately", async () => {
		for (const failAt of ["launch", "prepare", "smoke", "none"]) {
			const commands: string[] = [];
			const signalsBefore = process.listenerCount("SIGTERM");
			const result = await runTextEditFixture({
				context: { projectRoot: "/project", deadline: Date.now() + 90_000, progress() {} },
				helper: {}, steps: [smoke], artifacts: {},
				createSupervisor: () => ({
					async request(command: string) {
						commands.push(command);
						if (command === failAt) throw new Error(`refused ${command}`);
						return command === "smoke" ? { text: "ghbdtn ", pairs: 7 } : {};
					},
					cancel() {}, async close() { commands.push("cleanup"); return { cleanup: "manualRequired", helperReleased: true }; },
				}),
			});
			expect(result.status).toBe(failAt === "none" ? "PASSED" : "FAILED");
			expect(result.observations[result.observations.length - 1]).toMatchObject({ cleanup: "manualRequired", automaticAppTermination: false });
			expect(commands[commands.length - 1]).toBe("cleanup");
			if (failAt === "launch") expect(commands).toEqual(["launch", "cleanup"]);
			if (failAt === "prepare") expect(commands).toEqual(["launch", "prepare", "cleanup"]);
			expect(process.listenerCount("SIGTERM")).toBe(signalsBefore);
		}
	});
});
