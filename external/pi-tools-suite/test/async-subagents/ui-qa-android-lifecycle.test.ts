import { describe, expect, test } from "bun:test";
import { createAndroidLifecycle, resumesAndroidApp, validateAndroidLifecycle } from "../../src/async-subagents/agents/ui-qa/drivers/android/lifecycle.mjs";
import { validateAndroidSteps } from "../../src/async-subagents/agents/ui-qa/backends/android.mjs";

const BOOT = "11111111-1111-1111-1111-111111111111";
function fixture() {
	const state = {
		boot: BOOT, focus: "your.app", home: "com.android.launcher3/.Launcher",
		app: "your.app/.MainActivity", launchOutput: "Status: ok\nComplete\n",
		changeBootAfterResolve: false, foreignAfterHome: false,
	};
	const calls: string[][] = [];
	const client = {
		identity: async () => state.boot,
		focusedPackage: async () => state.focus,
		foreground: async () => { if (state.focus !== "your.app") throw new Error("not foreground"); },
		command: async (args: string[]) => {
			calls.push(args);
			if (args.includes("resolve-activity")) {
				if (state.changeBootAfterResolve) state.boot = "22222222-2222-2222-2222-222222222222";
				return Buffer.from(args.includes("android.intent.category.HOME") ? state.home : state.app);
			}
			if (args.join(" ") === "shell input keyevent KEYCODE_HOME") {
				state.focus = state.foreignAfterHome ? "foreign.app" : "com.android.launcher3";
				return Buffer.alloc(0);
			}
			if (args.slice(0, 3).join(" ") === "shell am start") {
				state.focus = "your.app";
				return Buffer.from(state.launchOutput);
			}
			throw new Error("unexpected fixture command");
		},
	};
	const lifecycle = createAndroidLifecycle(client, { package: "your.app" }, BOOT, { deadline: Date.now() + 2000 });
	return { state, calls, lifecycle, mutations: () => calls.filter((args) => !args.includes("resolve-activity")) };
}

describe("bounded Android lifecycle", () => {
	test("validates explicit operations/waits; rejects passthrough fields", () => {
		for (const operation of ["background", "resume", "restart"]) expect(() => validateAndroidSteps([{ action: "appLifecycle", operation }])).not.toThrow();
		for (const operation of [undefined, "clear", "stop", "resume;id", 1]) expect(() => validateAndroidSteps([{ action: "appLifecycle", operation }])).toThrow();
		for (const field of ["package", "component", "command"]) expect(() => validateAndroidSteps([{ action: "appLifecycle", operation: "resume", [field]: "foreign.app" }])).toThrow();
		for (const durationMs of [99, 20001, 1.5, "100"]) expect(() => validateAndroidLifecycle({ action: "wait", durationMs })).toThrow();
		expect(() => validateAndroidSteps([{ action: "wait", durationMs: 100 }])).not.toThrow();
		expect(resumesAndroidApp([{ action: "appLifecycle", operation: "resume" }])).toBe(true);
		expect(resumesAndroidApp([{ action: "screenshot" }, { action: "appLifecycle", operation: "resume" }])).toBe(false);
	});
	test("background/resume only uses HOME and resolved target launcher", async () => {
		const f = fixture();
		await f.lifecycle.run("background");
		expect(f.state.focus).toBe("com.android.launcher3");
		await f.lifecycle.guardBackground();
		await f.lifecycle.run("resume");
		expect(f.state.focus).toBe("your.app");
		expect(f.mutations()).toEqual([
			["shell", "input", "keyevent", "KEYCODE_HOME"],
			["shell", "am", "start", "-W", "--user", "current", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", "your.app/.MainActivity"],
		]);
	});
	test("restart uses -S on exactly the resolved target, with no data operation", async () => {
		const f = fixture();
		await f.lifecycle.run("restart");
		expect(f.mutations()).toEqual([["shell", "am", "start", "-W", "--user", "current", "-S", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", "your.app/.MainActivity"]]);
	});
	test.each(["foreign.app/.MainActivity", "your.app/.MainActivity;id", "your.app/.Main$Injected", "No activity found", "your.app/.MainActivity\nforeign.app/.Other"])("rejects unsafe launcher %s", async (component) => {
		const f = fixture(); f.state.app = component;
		await expect(f.lifecycle.run("resume")).rejects.toThrow("resolved safely");
		expect(f.mutations()).toHaveLength(0);
	});
	test("foreign focus blocks even when resume is the first action", async () => {
		const f = fixture(); f.state.focus = "foreign.app";
		await expect(f.lifecycle.run("resume")).rejects.toThrow("neither target app nor resolved HOME");
		expect(f.mutations()).toHaveLength(0);
	});
	test("app-as-HOME is unsupported, not an excuse to launch another application", async () => {
		const f = fixture(); f.state.home = "your.app/.MainActivity";
		await expect(f.lifecycle.run("background")).rejects.toThrow("HOME handler");
		expect(f.mutations()).toHaveLength(0);
	});
	test("boot change between resolve and mutation fails closed", async () => {
		const f = fixture(); f.state.changeBootAfterResolve = true;
		await expect(f.lifecycle.run("background")).rejects.toThrow("identity changed");
		expect(f.mutations()).toHaveLength(0);
	});
	test("unexpected focus after HOME aborts without another input", async () => {
		const f = fixture(); f.state.foreignAfterHome = true;
		await expect(f.lifecycle.run("background")).rejects.toThrow("neither target app nor resolved HOME");
		expect(f.mutations()).toHaveLength(1);
	});
	test("launch needs a positive acknowledgement, not just adb exit zero", async () => {
		const f = fixture(); f.state.launchOutput = "Error: activity missing\n";
		await expect(f.lifecycle.run("resume")).rejects.toThrow("acknowledgement unavailable");
	});
});
