import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { androidInputCommand, createAndroidClient, validateAndroidTarget } from "../../src/async-subagents/agents/ui-qa/drivers/android/adb.mjs";
import { androidTapPoint, parseAndroidHierarchy, rotatedAndroidSize, selectAndroidNodes, validateAndroidPng } from "../../src/async-subagents/agents/ui-qa/drivers/android/hierarchy.mjs";
import { probeAndroidBackend, validateAndroidSteps } from "../../src/async-subagents/agents/ui-qa/backends/android.mjs";
import { prepareUiQaWorkspace } from "../../src/async-subagents/core/ui-qa-workspace.js";
import { noIdleHierarchyCommand, parseNoIdleHierarchyResult, requireStableAndroidNode, verifyNoIdleHelperBundle } from "../../src/async-subagents/agents/ui-qa/drivers/android/no-idle.mjs";
import { HELPER_BASE64, HELPER_SHA256, HELPER_SOURCE_SHA256 } from "../../src/async-subagents/agents/ui-qa/drivers/android/helper-bundle.mjs";

const runner = path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/scripts/ui-qa-runner.mjs");
const lookup = process.platform === "win32" ? ["where.exe", "node.exe"] : ["which", "node"];
const node = spawnSync(lookup[0], [lookup[1]], { encoding: "utf8" }).stdout.trim().split(/\r?\n/)[0];
const dirs: string[] = [];
let server: ChildProcess | undefined;
setDefaultTimeout(30_000);

beforeAll(async () => {
	// A fake adb executable is used throughout. A listener is needed only for
	// the existing-server safety check, never for real ADB protocol/commands.
	await new Promise<void>((resolve, reject) => {
		// This must be a separate process: runner invocations use spawnSync.
		server = spawn(node, ["-e", `
const net = require('node:net');
const server = net.createServer(socket => {
  let request = '';
  socket.on('data', data => {
    request += data.toString('ascii');
    if (request === '000chost:version') socket.end('OKAY00040029');
    else if (request.length >= 16) socket.destroy();
  });
});
server.once('error', error => { console.log(error.code); process.exit(error.code === 'EADDRINUSE' ? 0 : 1); });
server.listen(5037, '127.0.0.1', () => console.log('ready'));
`], { stdio: ["ignore", "pipe", "pipe"] });
		server.once("error", reject);
		server.stdout!.once("data", (chunk) => ["ready", "EADDRINUSE"].includes(chunk.toString().trim()) ? resolve() : reject(new Error("fixture listener failed")));
	});
});
afterAll(() => server?.kill("SIGTERM"));
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const XML = '<hierarchy rotation="0"><node package="your.app" text="Schedules" content-desc="" class="android.widget.Button" enabled="true" checked="false" bounds="[0,0][80,40]"/><node package="other.app" text="Secret"/></hierarchy>';

function fixture(config = {}) {
	const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "android-qa-")));
	dirs.push(project);
	const agentDir = prepareUiQaWorkspace(project, "run", "qa");
	const adbPath = path.join(project, "adb");
	const log = path.join(project, "argv.jsonl");
	const state = path.join(project, "state.json");
	fs.writeFileSync(state, JSON.stringify({ calls: 0, screen: "Home", ...config }));
	// Fixed fixture paths are serialized, never composed into a shell command.
	fs.writeFileSync(adbPath, `#!${node}
const fs = require('node:fs');
const statePath = ${JSON.stringify(state)};
const log = ${JSON.stringify(log)};
const a = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(a) + '\\n');
const s = JSON.parse(fs.readFileSync(statePath));
s.calls++;
const cmd = a.slice(6).join(' ');
const width = s.rotation % 2 ? 40 : 80;
const height = s.rotation % 2 ? 80 : 40;
let out = '';
if (s.hang) { setInterval(() => {}, 1000); }
else if (s.flood) { process.stdout.write('x'.repeat(4*1024*1024)); }
else {
if (cmd === 'version') out = 'Android Debug Bridge version 1.0.' + (s.version ?? 41);
else if (cmd === 'get-state') out = 'device';
else if (cmd === 'shell getprop ro.kernel.qemu') out = s.qemu ?? '1';
else if (cmd.includes('qemu.avd_name')) out = s.avd ?? 'test_avd';
else if (cmd === 'shell cat /proc/sys/kernel/random/boot_id') out = s.bootChanged || s.swapAt && s.calls >= s.swapAt ? '22222222-2222-2222-2222-222222222222' : '11111111-1111-1111-1111-111111111111';
else if (cmd === 'shell dumpsys window windows' && s.displayOwnedFocus) out = 'WINDOW MANAGER WINDOWS';
else if (cmd === 'shell dumpsys window' && s.noFullFocus) out = 'WINDOW MANAGER';
else if (cmd === 'shell dumpsys window windows' || cmd === 'shell dumpsys window') out = 'mCurrentFocus=Window{42 u0 ' + (s.focusAt && s.calls >= s.focusAt ? 'com.android.permissioncontroller' : s.foreground ?? 'your.app') + '/.MainActivity}';
else if (cmd === 'shell wm size') out = 'Physical size: 80x40';
else if (cmd.includes('cmd package resolve-activity') && cmd.includes('android.intent.category.HOME')) out = s.homeComponent ?? 'com.android.launcher3/.Launcher';
else if (cmd.includes('cmd package resolve-activity') && cmd.includes('android.intent.category.LAUNCHER')) out = s.launchComponent ?? 'your.app/.MainActivity';
else if (cmd === 'shell input keyevent KEYCODE_HOME') s.foreground = 'com.android.launcher3';
else if (cmd.startsWith('shell am start -W --user current ')) { s.foreground = 'your.app'; out = 'Status: ok\\nComplete\\n'; if (s.bootOnLaunch) s.bootChanged = true; }
else if (cmd === 'exec-out uiautomator dump /proc/self/fd/1' || cmd.startsWith('exec-out umask 077\\n')) {
  const helper = cmd.startsWith('exec-out umask 077\\n');
  if (helper) s.helperCalls = (s.helperCalls ?? 0) + 1;
  out = (helper ? s.noIdleXml : s.xml) ?? '<hierarchy rotation="' + (s.rotation ?? 0) + '"><node node-path="0.0" window-id="1" package="your.app" text="' + s.screen + '" enabled="true" bounds="[0,0][' + width + ',' + height + ']"/><node node-path="0.1" window-id="1" package="your.app" text="Open" enabled="true" bounds="[0,0][' + width + ',' + height + ']"/></hierarchy>';
  if (helper && s.helperChanges && s.helperCalls === 2) out = out.replace('node-path="0.1"', 'node-path="0.9"');
  if (helper) {
    if (s.helperExit) out = s.helperOutput ?? 'PIQA-ERR:ROOT_UNAVAILABLE';
    const id = cmd.match(/d=\\/data\\/local\\/tmp\\/pi-ui-qa-([0-9a-f]{32})/)[1];
    const trailer = '\\nPIQA-DONE:' + (s.helperForeignTrailer ? '0'.repeat(32) : id) + ':' + (s.helperExit ?? 0) + '\\n';
    if (!s.helperMissingTrailer && s.helperExit !== 76) out += trailer;
    if (s.helperDuplicateTrailer) out += trailer;
    // Real exec: loses remote exit codes. The adb client ALWAYS exits zero.
  }
  if (s.homeAfterHierarchy) s.foreground = 'com.android.launcher3';
}
else if (cmd.startsWith('shell if test ! -e /data/local/tmp/pi-ui-qa-')) { if (!s.helperResidue) out = 'PIQA-CLEAN:' + cmd.match(/pi-ui-qa-([0-9a-f]{32})/)[1] + '\\n'; }
else if (cmd.startsWith('shell ps -A -o ARGS && printf')) out = (s.helperProcess ? 'app_process /system/bin dev.pix.uiqa.HierarchyDump your.app' : 'unrelated process') + (s.helperPsUnframed ? '' : '\\nPIQA-PS-DONE\\n');
else if (cmd === 'exec-out false') { /* raw exec: returns client zero */ }
else if (cmd.startsWith('shell input ') && s.inputFails) { process.exit(7); }
else if (cmd === 'shell input tap 40 20' || cmd === 'shell input tap 20 40') s.screen = 'Schedules';
else if (/^shell input swipe [0-9]+ [0-9]+ [0-9]+ [0-9]+ [0-9]+$/.test(cmd)) s.screen = 'Scrolled';
else if (cmd === 'shell input keyevent KEYCODE_BACK') s.screen = 'Home';
else if (cmd === "shell input text 'Hello'") s.screen = 'Typed';
else if (cmd === 'exec-out screencap -p') { const p = Buffer.alloc(45); Buffer.from('89504e470d0a1a0a', 'hex').copy(p); p.writeUInt32BE(13,8); p.write('IHDR',12); p.writeUInt32BE(width,16); p.writeUInt32BE(height,20); p.write('IEND',37); if (s.appAfterHomeScreenshot && s.foreground === 'com.android.launcher3') s.foreground = 'your.app'; if (s.focusAfterScreenshot) s.foreground = 'com.android.permissioncontroller'; if (s.swapAfterScreenshot) s.bootChanged = true; fs.writeFileSync(statePath,JSON.stringify(s)); process.stdout.write(p); process.exit(0); }
else { process.stderr.write('unexpected fixture command: ' + cmd); process.exit(9); }
fs.writeFileSync(statePath, JSON.stringify(s));
process.stdout.write(out);
}
`, { mode: 0o700 });
	const target = { adbPath, serial: "emulator-5580", avdName: "test_avd", package: "your.app" };
	function run(steps: unknown[], options: { target?: unknown; command?: string; timeout?: number } = {}) {
		const flow = path.join(agentDir, "ui-qa/flows", `flow-${Date.now()}-${Math.random()}.jsonc`);
		fs.writeFileSync(flow, JSON.stringify({ target: options.target ?? { android: target }, steps }), { mode: 0o600 });
		const result = spawnSync(node, [runner, options.command ?? "run", "--flow", flow, "--runner-timeout-ms", String(options.timeout ?? 15000)], {
			cwd: project, env: { ...process.env, PI_SUBAGENT_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 25000,
		});
		const payload = JSON.parse(result.stdout.trim().split("\n").slice(-1)[0] ?? "{}");
		return { ...result, payload };
	}
	function calls(): string[][] { return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []; }
	return { project, agentDir, target, run, calls };
}

describe("Android target and command safety", () => {
	test("rejects physical/TCP/ambiguous descriptors and unknown fields", () => {
		const f = fixture();
		for (const serial of ["usb-device", "10.0.0.1:5555", "emulator-5580 ", "emulator-1"]) expect(() => validateAndroidTarget({ ...f.target, serial })).toThrow();
		for (const change of [{ avdName: "" }, { package: "your.app;id" }, { adbPath: "adb" }, { shell: "id" }]) expect(() => validateAndroidTarget({ ...f.target, ...change })).toThrow();
		const result = f.run([], { command: "probe", target: { android: f.target, url: "http://localhost" } });
		expect(result.payload.status).toBe("BLOCKED");
		expect(f.calls()).toHaveLength(0);
	});
	test("unselected shallow probe performs no IO", async () => {
		expect((await probeAndroidBackend({ shallow: true })).available).toBe(true);
	});
	test("safe key/text allowlists reject shell and system mutations", () => {
		for (const key of ["POWER", "VOLUME_UP", "26", "HOME"]) expect(() => androidInputCommand({ action: "pressKey", key })).toThrow();
		for (const text of ["x;id", "$(id)", "`id`", "100%", "x\ny", "Привет", "'"]) expect(() => androidInputCommand({ action: "inputText", text })).toThrow();
		expect(androidInputCommand({ action: "inputText", text: "Hello 2" })).toEqual(["shell", "input", "text", "'Hello%s2'"]);
		expect(() => validateAndroidSteps([{ action: "shell", command: "id" }])).toThrow();
		expect(() => validateAndroidSteps([{ action: "tap", selector: { text: "x" }, x: 2 }])).toThrow();
	});
});

describe("bounded Android hierarchy", () => {
	test("classifies the exact stock idle failure without exposing output", () => {
		for (const suffix of ["\n", "\r\n"]) expect(() => parseAndroidHierarchy("ERROR: could not get idle state." + suffix)).toThrow("UIAutomator idle timeout");
		expect(() => parseAndroidHierarchy("private text ERROR: could not get idle state.")).toThrow("invalid Android hierarchy XML token");
		expect(parseAndroidHierarchy('<hierarchy><node text="ERROR: could not get idle state."/></hierarchy>').nodes[0].text).toBe("ERROR: could not get idle state.");
	});
	test("parses exact app selectors and rejects system nodes/ambiguity", () => {
		const view = parseAndroidHierarchy('<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' + XML + '\nUI hierchary dumped to: /dev/tty');
		expect(selectAndroidNodes(view.nodes, { text: "Schedules" }, "your.app")).toHaveLength(1);
		expect(selectAndroidNodes(view.nodes, { text: "Secret" }, "your.app")).toHaveLength(0);
		expect(androidTapPoint(view.nodes[0], { width: 80, height: 40 })).toEqual([40, 20]);
	});
	test("rejects malformed/oversized/deep/entity XML and invalid bounds", () => {
		for (const xml of ['<!DOCTYPE hierarchy>' + XML, '<hierarchy><node text="&xx;"/></hierarchy>', '<hierarchy><node></hierarchy>', '<hierarchy>' + '<node>'.repeat(65) + '</node>'.repeat(65) + '</hierarchy>', 'x'.repeat(2 * 1024 * 1024 + 1), '<hierarchy>' + '<node/>'.repeat(5001) + '</hierarchy>', '<hierarchy><node' + Array.from({ length: 41 }, (_, n) => ` attr${n}="x"`).join('') + '/></hierarchy>']) expect(() => parseAndroidHierarchy(xml)).toThrow();
		for (const bounds of ["[1,2][0,3]", "[-1,0][2,2]", "[0,0][999,999]"]) expect(() => androidTapPoint({ enabled: "true", bounds }, { width: 80, height: 40 })).toThrow();
	});
	test("redacts password values and handles XML entities", () => {
		const view = parseAndroidHierarchy('<hierarchy><node package="your.app" text="secret" password="true"/><node package="your.app" text="A &amp; B &#x41;"/></hierarchy>');
		expect(view.xml).not.toContain('text="secret"');
		expect(selectAndroidNodes(view.nodes, { text: "secret" }, "your.app")).toHaveLength(0);
		expect(view.nodes[1].text).toBe("A & B A");
		expect(() => validateAndroidPng(Buffer.from("not png"), { width: 80, height: 40 })).toThrow();
	});
	test("accepts both known status spellings on the stdout descriptor", () => {
		for (const spelling of ["hierchary", "hierarchy"]) expect(parseAndroidHierarchy(XML + `\nUI ${spelling} dumped to: /proc/self/fd/1\n`).nodes).toHaveLength(2);
	});
});

describe("unified Android runner", () => {
	test("bounded lifecycle captures background/resume/restart without XML or app-data access", () => {
		const f = fixture({ xml: "ERROR: could not get idle state.\n" });
		const result = f.run([
			{ action: "screenshot" },
			{ action: "appLifecycle", operation: "background" },
			{ action: "wait", durationMs: 100, timeoutMs: 5000 },
			{ action: "screenshot" },
			{ action: "appLifecycle", operation: "resume" },
			{ action: "appLifecycle", operation: "restart" },
			{ action: "screenshot" },
		]);
		expect(result.payload.reason ?? result.payload.status).toBe("PASSED");
		expect(result.payload.artifacts.screenshots).toHaveLength(9);
		expect(f.calls().some((args) => /uiautomator|app_process|clear|uninstall/.test(args.join(" ")))).toBe(false);
		expect(f.calls().filter((args) => args.includes("KEYCODE_HOME"))).toHaveLength(1);
		expect(f.calls().filter((args) => args.includes("-S"))).toHaveLength(1);
	});
	test("only an explicit first resume can attach to the resolved HOME", () => {
		const f = fixture({ foreground: "com.android.launcher3" });
		expect(f.run([{ action: "screenshot" }]).payload.status).toBe("BLOCKED");
		expect(f.run([{ action: "appLifecycle", operation: "resume" }, { action: "screenshot" }]).payload.status).toBe("PASSED");
	});
	test.each([{ action: "tapPoint", x: 40, y: 20 }, { action: "pressKey", key: "BACK" }])("HOME observation never grants input to the launcher: %j", (step) => {
		const f = fixture();
		const result = f.run([{ action: "appLifecycle", operation: "background" }, step]);
		expect(result.payload.status).toBe("FAILED");
		expect(result.payload.reason).toContain("not the focused application");
		expect(f.calls().filter((args) => args.includes("input"))).toEqual([
			expect.arrayContaining(["KEYCODE_HOME"]),
		]);
	});
	test("boot change during lifecycle retains before evidence but forbids later input", () => {
		const f = fixture({ bootOnLaunch: true });
		const result = f.run([{ action: "appLifecycle", operation: "restart" }, { action: "tapPoint", x: 40, y: 20 }]);
		expect(result.payload.status).toBe("FAILED");
		expect(result.payload.reason).toContain("identity changed");
		expect(result.payload.artifacts.screenshots).toHaveLength(1);
		expect(f.calls().some((args) => args.includes("input"))).toBe(false);
	});
	test("background mode cannot turn app selector geometry into HOME input", () => {
		const f = fixture({ appAfterHomeScreenshot: true, homeAfterHierarchy: true });
		const result = f.run([{ action: "appLifecycle", operation: "background" }, { action: "tap", selector: { text: "Open" } }]);
		expect(result.payload.status).toBe("FAILED");
		expect(result.payload.reason).toContain("not the focused application");
		expect(f.calls().filter((args) => args.includes("input"))).toEqual([expect.arrayContaining(["KEYCODE_HOME"])]);
	});
	test("visual ADB route taps, swipes and keys without XML/helper even on idle failure", () => {
		const f = fixture({ xml: "ERROR: could not get idle state.\n", helperExit: 1 });
		const result = f.run([
			{ action: "tapPoint", x: 40, y: 20 },
			{ action: "swipe", startX: 40, startY: 30, endX: 40, endY: 5, durationMs: 200 },
			{ action: "pressKey", key: "BACK" },
			{ action: "screenshot", name: "home" },
		]);
		expect(result.payload.reason ?? result.payload.status).toBe("PASSED");
		expect(result.payload.selection.platformDriver).toBe("adb-screenshot");
		expect(result.payload.selection.guide.topic).toBe("adb");
		expect(result.payload.selection.supportedCapabilities).toContain("coordinateInput");
		expect(result.payload.artifacts.screenshots).toHaveLength(5);
		expect(result.payload.artifacts.accessibilitySnapshots).toHaveLength(0);
		expect(f.calls().filter((args) => args.includes("input"))).toHaveLength(3);
		expect(f.calls().some((args) => /uiautomator|app_process|pi-ui-qa-/.test(args.join(" ")))).toBe(false);
	});
	test("visual coordinates follow rotated screenshot pixels, not natural wm size", () => {
		const f = fixture({ rotation: 1 });
		expect(f.run([{ action: "tapPoint", x: 20, y: 40 }]).payload.status).toBe("PASSED");
	});
	test.each([
		{ action: "tapPoint", x: 40, y: 20 },
		{ action: "swipe", startX: 20, startY: 40, endX: 40, endY: 30 },
	])("out-of-PNG bounds fail before input and retain before evidence: %j", (step) => {
		const f = fixture({ rotation: 1 });
		const result = f.run([step]);
		expect(result.payload.reason).toContain("inside the current screenshot");
		expect(result.payload.artifacts.screenshots).toHaveLength(1);
		expect(f.calls().some((args) => args.includes("input"))).toBe(false);
	});
	test.each([{ focusAfterScreenshot: true }, { swapAfterScreenshot: true }])("visual input blocked when foreground/boot changes: %j", (config) => {
		const f = fixture(config);
		expect(f.run([{ action: "tapPoint", x: 40, y: 20 }]).payload.status).toBe("FAILED");
		expect(f.calls().some((args) => args.includes("input"))).toBe(false);
	});
	test("failed coordinate input retains its before PNG and is not retried", () => {
		const f = fixture({ inputFails: true });
		const result = f.run([{ action: "tapPoint", x: 40, y: 20 }]);
		expect(result.payload.status).toBe("FAILED");
		expect(result.payload.artifacts.screenshots).toHaveLength(1);
		expect(f.calls().filter((args) => args.includes("input"))).toHaveLength(1);
	});
	test("coordinate schemas reject injection, floats, missing fields and unbounded gestures", () => {
		for (const step of [
			{ action: "tapPoint", x: "1;id", y: 0 }, { action: "tapPoint", x: 1.5, y: 0 },
			{ action: "tapPoint", x: -1, y: 0 }, { action: "tapPoint", x: 16384, y: 0 },
			{ action: "tapPoint", x: 0 }, { action: "tapPoint", x: 0, y: 0, selector: { text: "x" } },
			...[99, 2001, "300;id", 1.5].map((durationMs) => ({ action: "swipe", startX: 1, startY: 1, endX: 2, endY: 2, durationMs })),
			{ action: "swipe", startX: 1, startY: 1, endX: 2 },
		]) expect(() => validateAndroidSteps([step])).toThrow();
		expect(androidInputCommand({ action: "swipe", startX: 1, startY: 1, endX: 2, endY: 2 })).toEqual(["shell", "input", "swipe", "1", "1", "2", "2", "300"]);
	});
	test("no-idle mode is explicit and probe never deploys a helper", () => {
		const f = fixture();
		for (const change of [{ hierarchyMode: "anything" }, { helperPath: "/tmp/x" }, { helperBytes: "x" }]) expect(() => validateAndroidTarget({ ...f.target, ...change })).toThrow();
		expect(f.run([], { command: "probe", target: { android: { ...f.target, hierarchyMode: "no-idle" } } }).payload.status).toBe("AVAILABLE");
		expect(f.calls().some((args) => args.join(" ").includes("umask 077"))).toBe(false);
	});
	test("no-idle capture, stable double-read tap, assertions and cleanup", () => {
		const f = fixture({ xml: "ERROR: could not get idle state.\n" });
		const result = f.run([{ action: "capture" }, { action: "tap", selector: { text: "Open" } }, { action: "assertText", text: "Schedules" }, { action: "assertHelperCleanup" }], { target: { android: { ...f.target, hierarchyMode: "no-idle" } }, timeout: 60000 });
		expect(result.payload.reason ?? result.payload.status).toBe("PASSED");
		expect(result.payload.assertions).toHaveLength(2);
		expect(result.payload.observations.filter((item: { action: string }) => item.action === "temporaryHelperCleanup")).toHaveLength(4);
		expect(f.calls().some((args) => args.includes("uiautomator"))).toBe(false);
	});
	test("unstable node identity prevents no-idle input", () => {
		const f = fixture({ helperChanges: true });
		const result = f.run([{ action: "tap", selector: { text: "Open" } }], { target: { android: { ...f.target, hierarchyMode: "no-idle" } }, timeout: 60000 });
		expect(result.payload.reason).toContain("changed between no-idle snapshots");
		expect(f.calls().some((args) => args.includes("input"))).toBe(false);
	});
	test("no-idle text input uses two fresh focused non-password snapshots", () => {
		const f = fixture({ noIdleXml: '<hierarchy rotation="0"><node node-path="0" window-id="1" class="android.widget.EditText" package="your.app" text="" focused="true" password="false" enabled="true" bounds="[0,0][80,40]"/></hierarchy>' });
		expect(f.run([{ action: "inputText", text: "Hello" }], { target: { android: { ...f.target, hierarchyMode: "no-idle" } }, timeout: 60000 }).payload.status).toBe("PASSED");
		expect(f.calls().filter((args) => args.join(" ").includes("exec-out umask 077"))).toHaveLength(2);
		expect(f.calls().filter((args) => args.includes("input"))).toHaveLength(1);
	});
	test("short no-idle budgets never start a helper", () => {
		const f = fixture();
		const result = f.run([{ action: "snapshotAccessibility", timeoutMs: 5000 }], { target: { android: { ...f.target, hierarchyMode: "no-idle" } } });
		expect(result.payload.reason).toContain("helper not started");
		expect(f.calls().some((args) => args.join(" ").includes("umask 077"))).toBe(false);
	});
	test.each([
		{ config: { helperExit: 1 }, reason: "ROOT_UNAVAILABLE" },
		{ config: { helperExit: 1, helperOutput: "private output" }, reason: "status 1" },
		{ config: { helperExit: 124 }, reason: "timed out" },
		{ config: { helperExit: 76 }, reason: "cleanup unverified" },
	])("helper failures never parse or expose raw failed output %j", ({ config, reason }) => {
		const f = fixture(config);
		const result = f.run([{ action: "snapshotAccessibility" }], { target: { android: { ...f.target, hierarchyMode: "no-idle" } }, timeout: 60000 });
		expect(result.payload.reason).toContain(reason);
		expect(JSON.stringify(result.payload)).not.toContain("private output");
		expect(result.payload.artifacts.accessibilitySnapshots).toHaveLength(0);
		expect(result.payload.observations.find((item: { action: string }) => item.action === "temporaryHelperCleanup").status).toBe(config.helperExit === 76 ? "unverified" : "confirmed");
	});
	test.each([{ helperMissingTrailer: true }, { helperForeignTrailer: true }, { helperDuplicateTrailer: true }])("client zero plus valid XML cannot fake completion: %j", (config) => {
		const f = fixture(config);
		const result = f.run([{ action: "snapshotAccessibility" }], { target: { android: { ...f.target, hierarchyMode: "no-idle" } }, timeout: 60000 });
		expect(result.payload.reason).toContain("cleanup unverified");
		expect(result.payload.observations.find((item: { action: string }) => item.action === "temporaryHelperCleanup").status).toBe("unverified");
		expect(result.payload.artifacts.accessibilitySnapshots).toHaveLength(0);
	});
	test.each([{ helperResidue: true }, { helperPsUnframed: true }])("cleanup inspection also requires explicit acknowledgments: %j", (config) => {
		const f = fixture(config);
		expect(f.run([{ action: "assertHelperCleanup", runId: "a".repeat(32) }]).payload.status).toBe("FAILED");
	});
	test("no-idle requires explicit rotation", () => {
		const f = fixture({ noIdleXml: '<hierarchy><node package="your.app"/></hierarchy>' });
		expect(f.run([{ action: "snapshotAccessibility" }], { target: { android: { ...f.target, hierarchyMode: "no-idle" } }, timeout: 60000 }).payload.reason).toContain("requires explicit rotation");
	});
	test("cleanup assertion rejects a surviving helper process", () => {
		const f = fixture({ helperProcess: true });
		expect(f.run([{ action: "assertHelperCleanup", runId: "a".repeat(32) }]).payload.reason).toContain("still present");
		expect(() => validateAndroidSteps([{ action: "assertHelperCleanup", runId: "../../etc" }])).toThrow();
	});
	test("screenshots do not require an idle hierarchy", () => {
		const f = fixture({ xml: "ERROR: could not get idle state.\n" });
		const result = f.run([{ action: "screenshot", name: "clock" }]);
		expect(result.payload.status).toBe("PASSED");
		expect(result.payload.artifacts.screenshots).toHaveLength(1);
		expect(f.calls().some((args) => args.includes("uiautomator"))).toBe(false);
	});
	test("failed XML capture still retains PNG and safe format diagnostics", () => {
		const f = fixture({ xml: "ERROR: could not get idle state.\n" });
		const result = f.run([{ action: "capture", name: "clock" }]);
		expect(result.payload.status).toBe("FAILED");
		expect(result.payload.reason).toContain("UIAutomator idle timeout");
		expect(result.payload.artifacts.screenshots).toHaveLength(1);
		expect(result.payload.artifacts.accessibilitySnapshots).toHaveLength(0);
		expect(result.payload.observations.find((item: { action: string; uiautomatorError?: boolean }) => item.action === "hierarchyParseFailure").uiautomatorError).toBe(true);
	});
	test("focus can be display-owned rather than present in windows-only dump", () => {
		const f = fixture({ displayOwnedFocus: true });
		expect(f.run([], { command: "probe" }).payload.status).toBe("AVAILABLE");
		expect(f.calls().some((args) => args.slice(6).join(" ") === "shell dumpsys window")).toBe(true);
	});
	test.each([
		{ config: { displayOwnedFocus: true, foreground: "com.android.systemui" }, reason: "com.android.systemui" },
		{ config: { displayOwnedFocus: true, noFullFocus: true }, reason: "no mCurrentFocus" },
	])("full-dump focus fallback also fails closed %j", ({ config, reason }) => {
		const f = fixture(config);
		const result = f.run([{ action: "tap", selector: { text: "Open" } }]);
		expect(result.payload.status).toBe("BLOCKED");
		expect(result.payload.reason).toContain(reason);
		expect(f.calls().some((args) => args.includes("input"))).toBe(false);
	});
	test("version mismatch leaves shared daemon and device untouched", () => {
		const f = fixture({ version: 42 });
		const result = f.run([{ action: "tap", selector: { text: "Open" } }]);
		expect(result.payload.status).toBe("BLOCKED");
		expect(result.payload.reason).toContain("protocol mismatch");
		expect(f.calls().every((args) => args.slice(6).join(" ") === "version")).toBe(true);
	});
	test("current rotation governs PNG and tap bounds, without rotating the device", () => {
		const f = fixture({ rotation: 1 });
		const result = f.run([{ action: "capture" }, { action: "tap", selector: { text: "Open" } }, { action: "assertText", text: "Schedules" }]);
		expect(result.payload.reason ?? result.payload.status).toBe("PASSED");
		expect(f.calls().some((args) => args.slice(6).join(" ") === "shell input tap 20 40")).toBe(true);
		expect(rotatedAndroidSize({ width: 80, height: 40 }, 3)).toEqual({ width: 40, height: 80 });
	});
	test("probe, real command templates, navigation assertions and private evidence", () => {
		const f = fixture();
		expect(f.run([], { command: "probe" }).payload.selection.selectedBackend).toBe("android");
		const result = f.run([
			{ action: "capture", name: "before" }, { action: "assertText", text: "Home" },
			{ action: "tap", selector: { text: "Open" } }, { action: "assertText", text: "Schedules" },
			{ action: "pressKey", key: "BACK" }, { action: "assertText", text: "Home" },
			{ action: "capture", name: "after" },
		]);
		expect(result.payload.reason ?? result.payload.status).toBe("PASSED");
		expect(result.payload.assertions).toHaveLength(3);
		expect(result.payload.artifacts.screenshots).toHaveLength(2);
		for (const bucket of ["screenshots", "accessibilitySnapshots"]) for (const item of result.payload.artifacts[bucket]) {
			expect(fs.existsSync(item.path)).toBe(true);
			expect(fs.statSync(item.path).mode & 0o077).toBe(0);
		}
		expect(f.calls().every((args) => args.slice(0, 6).join(" ") === "-H 127.0.0.1 -P 5037 -s emulator-5580")).toBe(true);
		expect(f.calls().some((args) => args.includes("install") || args.includes("run-as") || args.includes("settings"))).toBe(false);
	});
	test.each([{ qemu: "0" }, { avd: "wrong_avd" }, { foreground: "com.android.permissioncontroller" }])("identity/foreground blocks before input %j", (config) => {
		const f = fixture(config);
		const result = f.run([{ action: "tap", selector: { text: "Open" } }]);
		expect(result.payload.status).toBe("BLOCKED");
		expect(f.calls().some((args) => args.includes("input"))).toBe(false);
	});
	test("boot change after attachment prevents input", () => {
		const f = fixture({ swapAt: 18 });
		const result = f.run([{ action: "tap", selector: { text: "Open" } }]);
		expect(result.payload.status).toBe("FAILED");
		expect(result.payload.reason).toContain("identity changed");
		expect(f.calls().some((args) => args.includes("input"))).toBe(false);
	});
	test("system dialog appearing after attachment prevents input", () => {
		const f = fixture({ focusAt: 27 });
		const result = f.run([{ action: "tap", selector: { text: "Open" } }]);
		expect(result.payload.status).toBe("FAILED");
		expect(result.payload.reason).toContain("not the focused application");
		expect(f.calls().some((args) => args.includes("input"))).toBe(false);
	});
	test.each([{ action: "tap", selector: { text: "Secret" } }, { action: "inputText", text: "hello" }])("rejects system selector or unfocused text field %j", (step) => {
		const f = fixture({ xml: XML });
		expect(f.run([step]).payload.status).toBe("FAILED");
		expect(f.calls().some((args) => args.includes("input"))).toBe(false);
	});
	test("ambiguous/system selectors are rejected", () => {
		const f = fixture({ xml: XML.replace('text="Secret"', 'text="Schedules"').replace('package="other.app"', 'package="your.app"') });
		const result = f.run([{ action: "tap", selector: { text: "Schedules" } }]);
		expect(result.payload.status).toBe("FAILED");
		expect(f.calls().some((args) => args.includes("input"))).toBe(false);
	});
	test("hung ADB client is killed within command deadline", async () => {
		const f = fixture({ hang: true });
		const client = createAndroidClient(f.target, { projectRoot: f.project, deadline: Date.now() + 200, stageTimeoutMs: 200 });
		const start = Date.now();
		await expect(client.identity()).rejects.toThrow("timed out");
		expect(Date.now() - start).toBeLessThan(2500);
	});
	test("ADB output is bounded without retaining device stderr", async () => {
		const f = fixture({ flood: true });
		const client = createAndroidClient(f.target, { projectRoot: f.project, deadline: Date.now() + 2000 });
		await expect(client.identity()).rejects.toThrow("output exceeds limit");
	});
	test("guide works without agent environment", () => {
		const result = spawnSync(node, [runner, "guide", "--backend", "android", "--topic", "adb-uiautomator"], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("No APK installation");
	});
});

describe("trusted no-idle helper", () => {
	test("bundle integrity, source hash, size and fixed bounded command", () => {
		verifyNoIdleHelperBundle();
		const bytes = Buffer.from(HELPER_BASE64, "base64");
		expect(bytes.length).toBeLessThanOrEqual(32768);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(HELPER_SHA256);
		const source = path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/drivers/android/helper/HierarchyDump.java");
		expect(createHash("sha256").update(fs.readFileSync(source)).digest("hex")).toBe(HELPER_SOURCE_SHA256);
		const command = noIdleHierarchyCommand("your.app", "a".repeat(32));
		expect(command.args).toHaveLength(2);
		expect(command.args[0]).toBe("exec-out");
		expect(Buffer.byteLength(command.args[1])).toBeLessThan(60000);
		expect(command.args[1]).toContain('timeout -s KILL 10 app_process /system/bin dev.pix.uiqa.HierarchyDump');
		expect(command.args[1].indexOf('mkdir -m 700 "$d"')).toBeLessThan(command.args[1].indexOf("trap 'cleanup"));
		expect(command.args[1].replace(HELPER_BASE64, "<BUNDLE>").replace(HELPER_SHA256, "<HASH>").split("a".repeat(32)).join("<RUN>")).toBe(`umask 077
d=/data/local/tmp/pi-ui-qa-<RUN>
mkdir -m 700 "$d" || exit 73
cleanup() { rm -rf -- "$d" && [ ! -e "$d" ] && [ ! -L "$d" ]; }
trap 'cleanup || exit 76' EXIT
trap 'exit 74' HUP INT TERM PIPE
printf %s '<BUNDLE>' | base64 -d > "$d/h.jar" || exit 75
chmod 400 "$d/h.jar" || exit 75
hash=$(sha256sum "$d/h.jar") || exit 75
[ "\${hash%% *}" = '<HASH>' ] || exit 75
mkdir -m 700 "$d/dalvik-cache" || exit 75
CLASSPATH="$d/h.jar" ANDROID_DATA="$d" timeout -s KILL 10 app_process /system/bin dev.pix.uiqa.HierarchyDump 'your.app' 2>/dev/null
result=$?
if ! cleanup; then trap - EXIT HUP INT TERM PIPE; exit 76; fi
trap - EXIT HUP INT TERM PIPE
printf '\\nPIQA-DONE:%s:%s\\n' '<RUN>' "$result"
exit 0`);
		for (const id of ["a", "../", "A".repeat(32)]) expect(() => noIdleHierarchyCommand("your.app", id)).toThrow();
		for (const pkg of ["x;id", "your.app'", "x".repeat(300)]) expect(() => noIdleHierarchyCommand(pkg)).toThrow();
		const node = { "node-path": "0.1", "window-id": "1", bounds: "[0,0][1,1]" };
		expect(() => requireStableAndroidNode(node, { ...node }, 0, 0)).not.toThrow();
		for (const field of ["node-path", "window-id", "bounds", "enabled", "package"]) expect(() => requireStableAndroidNode(node, { ...node, [field]: "changed" }, 0, 0)).toThrow();
		expect(() => requireStableAndroidNode(node, node, 0, 1)).toThrow();
	});
	test.each([5, 33000])("corrupt/oversize bundle fails before constructing commands: %i", async (size) => {
		const f = fixture();
		const driver = path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/drivers/android/no-idle.mjs");
		fs.copyFileSync(driver, path.join(f.project, "no-idle.mjs"));
		const bytes = Buffer.alloc(size); bytes.writeUInt32LE(0x04034b50);
		fs.writeFileSync(path.join(f.project, "helper-bundle.mjs"), `export const HELPER_BASE64=${JSON.stringify(bytes.toString("base64"))}; export const HELPER_SHA256=${JSON.stringify(HELPER_SHA256)};`);
		const corrupt = await import(path.join(f.project, "no-idle.mjs"));
		expect(() => corrupt.noIdleHierarchyCommand("your.app")).toThrow("integrity");
		expect(f.calls()).toHaveLength(0);
	});
	test.each(["success", "collision", "timeout"])("remote transaction cleanup with real shell: %s", (mode) => {
		const f = fixture();
		const bin = path.join(f.project, "bin"); fs.mkdirSync(bin);
		const dir = path.join(f.project, "remote");
		const tool = (name: string, source: string) => fs.writeFileSync(path.join(bin, name), `#!${node}\n${source}`, { mode: 0o700 });
		tool("sha256sum", `const fs=require('fs'),c=require('crypto'); console.log(c.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex')+'  '+process.argv[2]);`);
		tool("app_process", mode === "timeout" ? "setInterval(()=>{},1000);" : `process.stdout.write(${JSON.stringify(XML)});`);
		tool("timeout", `const cp=require('child_process'); const child=cp.spawn(process.argv[5],process.argv.slice(6),{stdio:'inherit'}); const timer=setTimeout(()=>child.kill('SIGKILL'),2000); child.on('exit',(code,signal)=>{clearTimeout(timer);process.exit(signal?137:code);});`);
		if (mode === "collision") { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "foreign"), "retain"); }
		const script = noIdleHierarchyCommand("your.app", "a".repeat(32)).args[1].replace(`/data/local/tmp/pi-ui-qa-${"a".repeat(32)}`, dir);
		const result = spawnSync("/bin/sh", ["-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 8000 });
		expect(result.status).toBe(mode === "collision" ? 73 : 0);
		if (mode === "collision") expect(fs.readFileSync(path.join(dir, "foreign"), "utf8")).toBe("retain");
		else {
			expect(fs.existsSync(dir)).toBe(false);
			expect(parseNoIdleHierarchyResult(result.stdout, "a".repeat(32)).status).toBe(mode === "timeout" ? 137 : 0);
		}
	});
});

describe("QA workspace resume", () => {
	test("creates a not-yet-existing project cwd as before", () => {
		const f = fixture();
		const cwd = path.join(f.project, "project with spaces");
		expect(fs.existsSync(cwd)).toBe(false);
		expect(fs.statSync(prepareUiQaWorkspace(cwd, "run", "qa")).isDirectory()).toBe(true);
	});
	test("preserves flows and evidence when same agent is resumed", () => {
		const f = fixture();
		const result = f.run([{ action: "capture" }]);
		expect(result.payload.status).toBe("PASSED");
		const root = prepareUiQaWorkspace(f.project, "run", "qa");
		expect(root).toBe(f.agentDir);
		for (const item of result.payload.artifacts.screenshots) expect(fs.existsSync(item.path)).toBe(true);
		expect(fs.readdirSync(path.join(root, "ui-qa/flows"))).not.toHaveLength(0);
		// An already-loaded pre-fix parent may still reset the disposable folder.
		// The runner's sibling evidence directory must survive even that reset.
		fs.rmSync(path.join(root, "ui-qa"), { recursive: true });
		prepareUiQaWorkspace(f.project, "run", "qa");
		for (const bucket of ["screenshots", "accessibilitySnapshots"]) for (const item of result.payload.artifacts[bucket]) expect(fs.existsSync(item.path)).toBe(true);
	});
	test("rejects workspace symlink and identity mismatch without deleting evidence", () => {
		const f = fixture();
		const marker = path.join(f.agentDir, "project_cwd");
		fs.writeFileSync(marker, "other-project\n");
		expect(() => prepareUiQaWorkspace(f.project, "run", "qa")).toThrow("identity mismatch");
		fs.writeFileSync(marker, `${f.project}\n`);
		fs.rmSync(path.join(f.agentDir, "ui-qa/flows"), { recursive: true });
		fs.symlinkSync(f.project, path.join(f.agentDir, "ui-qa/flows"));
		expect(() => prepareUiQaWorkspace(f.project, "run", "qa")).toThrow("real directories");
	});
});
