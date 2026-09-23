import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { probeBrowserBackend, resolveBrowserDriver, runBrowserBackend } from "../../src/async-subagents/agents/ui-qa/backends/browser.mjs";
import { desktopEvidenceName, desktopPlatformContract, launchedApplicationSelector, terminateOwnedProcessTree, validateDesktopStepCapabilities } from "../../src/async-subagents/agents/ui-qa/backends/desktop.mjs";
import { releaseWindowsPtyResources, resolveTuiPresentation, terminateOwnedPty, validateNativeTerminalSteps } from "../../src/async-subagents/agents/ui-qa/backends/tui.mjs";
import { CHROME_DEVTOOLS_DRIVER, chromeDevtoolsStartArgs, probeChromeDevtoolsProvider } from "../../src/async-subagents/agents/ui-qa/drivers/chrome-devtools/chrome-devtools-provider.mjs";
import { chooseNativeTerminalProvider, nativeTerminalBridgeCommandFile, nativeTerminalBridgeShellCommand, nativeTerminalProviderLaunchArgs } from "../../src/async-subagents/agents/ui-qa/drivers/native-terminal/native-terminal-host.mjs";

const runner = path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/scripts/ui-qa-runner.mjs");
const macosDesktopDriverSource = path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/drivers/macos/macos-accessibility.swift");
const windowsDesktopDriverSource = path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/drivers/windows/windows-uia.ps1");
const linuxDesktopDriverSource = path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/drivers/linux/linux-atspi.py");
const nodeLocator = process.platform === "win32"
	? { command: "where.exe", args: ["node.exe"] }
	: { command: "which", args: ["node"] };
const nodeLookup = spawnSync(nodeLocator.command, nodeLocator.args, { encoding: "utf8" });
const nodePath = nodeLookup.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
if (nodeLookup.status !== 0 || !nodePath) throw new Error(`Unable to locate Node.js: ${nodeLookup.stderr.trim()}`);
const nodeExecutable = fs.realpathSync(nodePath);
const tempDirs: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

setDefaultTimeout(60_000);

afterEach(() => {
	for (const child of children.splice(0)) {
		try { child.kill("SIGKILL"); } catch { /* already exited */ }
	}
	for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createProject(type = "ui-qa") {
	const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ui-qa-runner-")));
	tempDirs.push(project);
	const agentDir = path.join(project, ".pi", "subagents", "run", "qa");
	const uiWorkspace = path.join(agentDir, "ui-qa");
	const browserWorkspace = path.join(agentDir, "browser-qa");
	fs.mkdirSync(path.join(uiWorkspace, "flows"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(browserWorkspace, "flows"), { recursive: true, mode: 0o700 });
	for (const directory of [path.join(project, ".pi"), path.join(project, ".pi", "subagents"), path.join(project, ".pi", "subagents", "run"), agentDir, uiWorkspace, path.join(uiWorkspace, "flows"), browserWorkspace, path.join(browserWorkspace, "flows")]) {
		if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
	}
	fs.writeFileSync(path.join(agentDir, "prompt.md"), "QA prompt\n", { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "project_cwd"), `${project}\n`, { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "subagent_type"), `${type}\n`, { mode: 0o600 });
	return { project, agentDir, uiWorkspace };
}

function writeProjectFile(project: string, name: string, content: string) {
	const file = path.join(project, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, { mode: 0o700 });
	return file;
}

function writeFlow(uiWorkspace: string, name: string, value: unknown) {
	const file = path.join(uiWorkspace, "flows", name);
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	if (process.platform !== "win32") fs.chmodSync(file, 0o600);
	return file;
}

function invoke(project: string, agentDir: string, args: string[], timeout = 20_000, envOverrides: Record<string, string> = {}) {
	const result = spawnSync(nodeExecutable, [runner, ...args], {
		cwd: project,
		env: { ...process.env, ...envOverrides, PI_SUBAGENT_AGENT_DIR: agentDir },
		encoding: "utf8",
		timeout,
		maxBuffer: 2 * 1024 * 1024,
	});
	const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
	let payload: any;
	for (const line of lines.reverse()) {
		try { payload = JSON.parse(line); break; } catch { /* diagnostic line */ }
	}
	return { ...result, payload };
}

function expectRunnerStatus(result: ReturnType<typeof invoke>, expected: number): void {
	if (result.status === expected) return;
	throw new Error(JSON.stringify({
		expectedStatus: expected,
		actualStatus: result.status,
		signal: result.signal,
		error: result.error?.message,
		stderr: result.stderr?.trim(),
		payloadStatus: result.payload?.status,
		reason: result.payload?.reason,
		observations: result.payload?.observations,
	}, null, 2));
}

function expectUnifiedArtifacts(payload: any) {
	expect(Object.keys(payload.artifacts).sort()).toEqual([
		"accessibilitySnapshots", "downloads", "observations", "screenshots", "terminalCaptures", "traces", "videos",
	]);
}

function readAsciicast(file: string) {
	const lines = fs.readFileSync(file, "utf8").trim().split("\n");
	return { header: JSON.parse(lines[0]), events: lines.slice(1).map((line) => JSON.parse(line)) };
}

async function waitUntil(check: () => boolean, timeout = 5_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for expected process state");
}

/** Invoke `guide` from an arbitrary cwd without launcher-provided env. */
function invokeGuide(args: string[], cwd = os.tmpdir()) {
	const result = spawnSync(nodeExecutable, [runner, "guide", ...args], {
		cwd,
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 2 * 1024 * 1024,
		env: { ...process.env, PI_SUBAGENT_AGENT_DIR: "" },
	});
	return result;
}

function guidePath(name: string) {
	return path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/guides", name);
}

describe("ui-qa guide routing", () => {
	test("prints only the requested backend guide from the fixed allowlist", () => {
		const spaced = fs.mkdtempSync(path.join(os.tmpdir(), "ui-qa-guide-"));
		tempDirs.push(spaced);
		const spacedCwd = path.join(spaced, "cwd with spaces");
		fs.mkdirSync(spacedCwd, { recursive: true });
		for (const [backend, file] of [
			["browser", "browser.md"],
			["tui", "tui.md"],
			["desktop", "desktop.md"],
		] as const) {
			const result = invokeGuide(["--backend", backend], spacedCwd);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(fs.readFileSync(guidePath(file), "utf8"));
		}
	});

	test("serves the browser auth guide only through the explicit auth topic", () => {
		const authGuide = fs.readFileSync(guidePath("browser-auth.md"), "utf8");
		const browserGuide = invokeGuide(["--backend", "browser"], process.cwd());
		expect(browserGuide.status).toBe(0);
		expect(browserGuide.stdout).toBe(fs.readFileSync(guidePath("browser.md"), "utf8"));
		// Backend isolation: the plain browser guide points to the auth guide but
		// must not embed the scaffold/update workflow, and browser runs get no
		// TUI/desktop instructions.
		expect(browserGuide.stdout).not.toContain("QA_AUTH_UPDATE_REQUIRED");
		expect(browserGuide.stdout).not.toContain("--success-selector");
		expect(browserGuide.stdout).not.toContain("target.application");
		expect(browserGuide.stdout).not.toContain("waitForStable");
		const auth = invokeGuide(["--backend", "browser", "--topic", "auth"]);
		expect(auth.status).toBe(0);
		expect(auth.stdout).toBe(authGuide);
		expect(auth.stdout).toContain("auth scaffold");
		// TUI and desktop runs never receive browser/auth instructions.
		expect(invokeGuide(["--backend", "tui"]).stdout).not.toContain("Playwright");
		expect(invokeGuide(["--backend", "desktop"]).stdout).not.toContain("Playwright");
		expect(invokeGuide(["--backend", "tui"]).stdout).not.toContain("qa_auth.jsonc");
	});

	test("serves provider and platform detail guides only through backend-scoped topics", () => {
		for (const [backend, topic, file] of [
			["browser", "playwright", "browser-playwright.md"],
			["browser", "chrome-devtools", "browser-chrome-devtools.md"],
			["tui", "pty", "tui-pty.md"],
			["tui", "native-terminal", "tui-native-terminal.md"],
			["desktop", "macos-accessibility", "desktop-macos.md"],
			["desktop", "windows-uia", "desktop-windows.md"],
			["desktop", "linux-at-spi", "desktop-linux.md"],
		] as const) {
			const result = invokeGuide(["--backend", backend, "--topic", topic]);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(fs.readFileSync(guidePath(file), "utf8"));
		}
	});

	test("keeps base guides thin and provider details isolated", () => {
		const browser = invokeGuide(["--backend", "browser"]).stdout;
		const tui = invokeGuide(["--backend", "tui"]).stdout;
		const desktop = invokeGuide(["--backend", "desktop"]).stdout;
		expect(browser).not.toContain("--javascriptEvaluation=false");
		expect(browser).not.toContain("take_heapsnapshot");
		expect(browser).not.toContain("expectDialog");
		expect(tui).not.toContain("iTerm2");
		expect(tui).not.toContain("Alacritty");
		expect(desktop).not.toContain("ScreenCaptureKit");
		expect(desktop).not.toContain("PrintWindow");
		expect(desktop).not.toContain("pyatspi");
		expect(desktop).toContain("target.application");
		expect(desktop).toContain('{"name":"App Name"}');
		expect(desktop).toContain('{"launch":{"argv":["npm","run","dev"],"cwd":"desktop"}}');
		expect(desktop).toContain("Never use a bare string");
	});

	test("rejects unknown backends, topics, options, and extra arguments", () => {
		const rejections: Array<[string[], RegExp]> = [
			[["--backend", "web"], /unknown guide backend/],
			[["--backend", "../ui-qa/guides/browser"], /unknown guide backend/],
			[["--backend", "browser", "--topic", "locators"], /unknown guide topic for browser/],
			[["--backend", "browser", "--topic", "../../../etc/passwd"], /unknown guide topic for browser/],
			[["--backend", "tui", "--topic", "auth"], /unknown guide topic for tui/],
			[["--backend", "browser", "--topic", "native-terminal"], /unknown guide topic for browser/],
			[["--backend", "desktop", "--topic", "playwright"], /unknown guide topic for desktop/],
			[["--backend"], /invalid guide argument/],
			[["--backend", "browser", "--flow", "x.jsonc"], /unknown guide option/],
			[["--backend", "browser", "extra"], /invalid guide argument/],
			[["positional"], /invalid guide argument/],
			[[], /--backend is required/],
		];
		for (const [args, expected] of rejections) {
			const result = invokeGuide(args);
			expect(result.status).toBe(1);
			expect(result.stdout).not.toContain("# ");
			expect(JSON.parse(result.stdout.trim().split("\n").pop()!).reason).toMatch(expected);
		}
	});

	test("runs from an arbitrary project cwd including paths with spaces", () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "ui-qa-guide-"));
		tempDirs.push(project);
		const spaced = path.join(project, "space dir name");
		fs.mkdirSync(spaced, { recursive: true });
		for (const cwd of [project, spaced, os.tmpdir()]) {
			const result = invokeGuide(["--backend", "desktop"], cwd);
			expect(result.status).toBe(0);
			expect(result.stdout).toBe(fs.readFileSync(guidePath("desktop.md"), "utf8"));
		}
	});

	test("keeps every bundled guide within the bounded guide size", () => {
		for (const file of [
			"browser.md", "browser-auth.md", "browser-playwright.md", "browser-chrome-devtools.md",
			"tui.md", "tui-pty.md", "tui-native-terminal.md",
			"desktop.md", "desktop-macos.md", "desktop-windows.md", "desktop-linux.md",
		]) {
			expect(fs.statSync(guidePath(file)).size).toBeLessThanOrEqual(256 * 1024);
		}
	});
});

describe("capability-first UI QA runner", () => {
	test("gives repeated unnamed desktop evidence steps collision-free filenames", () => {
		expect(desktopEvidenceName(undefined, 1, "snapshot")).toBe("snapshot-2");
		expect(desktopEvidenceName(undefined, 6, "snapshot")).toBe("snapshot-7");
		expect(desktopEvidenceName(undefined, 5, "screenshot")).toBe("screenshot-6");
		expect(desktopEvidenceName("after-toggle", 6, "snapshot")).toBe("after-toggle");
	});

	test("selects the browser backend for a URL without launching Playwright", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		writeFlow(uiWorkspace, "browser.jsonc", { version: 1, target: { url: "https://example.test/path" } });
		const result = invoke(project, agentDir, ["probe", "--flow", "browser.jsonc"]);
		expectRunnerStatus(result, 0);
		expect(result.payload.status).toBe("AVAILABLE");
		expect(result.payload.selection.detectedTargetKind).toBe("browser");
		expect(result.payload.selection.selectedBackend).toBe("browser");
		expect(result.payload.selection.guide).toEqual({ backend: "browser", topic: "playwright" });
		expect(result.payload.selection.whySelected).toContain("browser");
		expectUnifiedArtifacts(result.payload);
	});

	test("selects Playwright or Chrome DevTools by browser capability rather than project identity", async () => {
		const ordinary = {
			target: { url: "https://example.test/" },
			steps: [{ action: "assertVisible", locator: { role: "heading", name: "Example" } }],
		};
		const devtools = {
			target: { url: "https://example.test/" },
			steps: [{ action: "assertNoConsoleErrors" }],
		};
		const authenticated = {
			target: { profile: "staging-admin" },
			steps: [{ action: "assertVisible", locator: { testId: "account" } }],
		};
		expect(resolveBrowserDriver(ordinary)).toBe("playwright");
		expect(resolveBrowserDriver(devtools)).toBe("chrome-devtools");
		expect(resolveBrowserDriver(authenticated)).toBe("playwright");
		expect(resolveBrowserDriver({ ...ordinary, target: { ...ordinary.target, devtools: { headless: false } } })).toBe("chrome-devtools");
		expect(resolveBrowserDriver({ ...ordinary, target: { ...ordinary.target, browserDriver: "chrome-devtools" } })).toBe("chrome-devtools");
		expect(resolveBrowserDriver({ ...devtools, target: { ...devtools.target, browserDriver: "playwright" } })).toBe("playwright");

		const explicitPlaywright = await probeBrowserBackend({
			flow: { ...devtools, target: { ...devtools.target, browserDriver: "playwright" } },
			browserRunnerPath: path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/browser/scripts/browser-qa-runner.mjs"),
		});
		expect(explicitPlaywright.available).toBe(false);
		expect(explicitPlaywright.platformDriver).toBe("playwright-trusted-runner");
		expect(explicitPlaywright.missingCapabilities).toContain("action:assertNoConsoleErrors");

		const authWithDevtools = await probeBrowserBackend({
			flow: { ...authenticated, target: { ...authenticated.target, devtools: { headless: false } } },
			browserRunnerPath: path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/browser/scripts/browser-qa-runner.mjs"),
		});
		expect(authWithDevtools.available).toBe(false);
		expect(authWithDevtools.missingCapabilities).toContain("chromeDevtoolsOptions");
	});

	test("starts Chrome DevTools with a per-run fail-closed security policy", () => {
		const args = chromeDevtoolsStartArgs({
			sessionId: "deadbeef",
			evidenceDir: "/tmp/ui qa evidence",
			allowedOrigins: ["https://example.test", "http://127.0.0.1:4312"],
			devtools: {},
		});
		expect(args).toContain("--sessionId");
		expect(args).toContain("deadbeef");
		expect(args).toContain("--redactNetworkHeaders=true");
		expect(args).toContain("--usageStatistics=false");
		expect(args).toContain("--performanceCrux=false");
		expect(args).toContain("--pageIdRouting=true");
		expect(args).toContain("--javascriptEvaluation=false");
		expect(args).toContain("--categoryExtensions=false");
		expect(args).toContain("--categoryPwa=false");
		expect(args).toContain("--experimentalVision=false");
		expect(args).toContain("--isolated=true");
		expect(args).toContain("--headless=true");
		expect(args).toContain("--workspace=/tmp/ui qa evidence");
		expect(args).toContain("--allowedUrlPattern=https://example.test/*");
		expect(args).toContain("--allowedUrlPattern=http://127.0.0.1:4312/*");
		expect(args.join(" ")).not.toContain("Cookie");
		expect(args.join(" ")).not.toContain("Authorization");
	});

	test("rejects non-loopback Chrome DevTools attach endpoints", async () => {
		const { project, agentDir } = createProject();
		await expect(runBrowserBackend({
			flow: {
				target: {
					url: "https://example.test/",
					browserDriver: "chrome-devtools",
					devtools: { browserUrl: "http://example.test:9222" },
				},
				steps: [{ action: "assertNoConsoleErrors" }],
			},
			projectRoot: project,
			agentDir,
			runId: "remote-attach-rejected",
			deadline: Date.now() + 10_000,
			progress() {},
		})).rejects.toThrow(/loopback/);
	});

	test("runs Chrome DevTools through an isolated owned daemon and stops only that session", async () => {
		if (process.platform === "win32") return;
		const { project, agentDir } = createProject();
		const evidenceDir = path.join(project, "devtools-evidence");
		fs.mkdirSync(evidenceDir, { mode: 0o700 });
		const fakeCli = writeProjectFile(project, "fake-chrome-devtools.mjs", `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = path.join(here, "fake-chrome-devtools.log");
const argv = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(argv) + "\\n");
if (argv[0] === "--version") { console.log("1.9.0"); process.exit(0); }
const command = argv[0];
const page = { id: 7, url: "https://example.test/", title: "Example", selected: true, isolatedContext: "owned" };
const snapshot = {
  id: "1_0", role: "RootWebArea", name: "Example",
  children: [
    { id: "1_1", role: "heading", name: "Example Domain" },
    { id: "1_2", role: "button", name: "Continue" }
  ]
};
if (command === "start" || command === "stop" || command === "close_page") process.exit(0);
if (command === "new_page" || command === "list_pages") console.log(JSON.stringify({ pages: [page] }));
else if (command === "take_snapshot") console.log(JSON.stringify({ snapshot }));
else if (command === "list_console_messages") console.log(JSON.stringify({ consoleMessages: [] }));
else if (command === "performance_start_trace") {
  const outputIndex = argv.indexOf("--filePath");
  if (outputIndex < 0) process.exit(2);
  fs.writeFileSync(argv[outputIndex + 1], "raw trace with https://example.test/?token=secret");
  console.log(JSON.stringify({
    traceSummary: "URL: https://example.test/?token=secret\\nCPU throttling: 1x\\n  - LCP: 217 ms\\n  - CLS: 0.03\\n",
    traceInsights: [{ insightName: "LCPBreakdown" }, { insightName: "RenderBlocking" }]
  }));
}
else { console.error("unsupported fake command: " + command); process.exit(1); }
`);
		const probe = await probeChromeDevtoolsProvider({
			chromeDevtoolsPath: fakeCli,
			flow: { target: { url: "https://example.test/" }, steps: [{ action: "assertNoConsoleErrors" }] },
		});
		expect(probe.available).toBe(true);
		expect(probe.platformDriver).toBe(CHROME_DEVTOOLS_DRIVER);

		const result = await runBrowserBackend({
			flow: {
				target: { url: "https://example.test/", browserDriver: "chrome-devtools" },
				steps: [
					{ action: "assertText", locator: { role: "heading", name: "Example Domain", exact: true }, includes: "Example Domain" },
					{ action: "assertNoConsoleErrors" },
					{ action: "snapshotAccessibility", name: "owned-page" },
					{ action: "performanceTrace", name: "owned-performance" },
				],
			},
			projectRoot: project,
			agentDir,
			runId: "devtools-owned",
			evidenceDir,
			deadline: Date.now() + 20_000,
			chromeDevtoolsPath: fakeCli,
			artifact(value: string) {
				const file = path.resolve(evidenceDir, value);
				return { path: file, uri: `file://${file}` };
			},
			progress() {},
		});
		expect(result.status).toBe("PASSED");
		expect(result.assertions).toHaveLength(2);
		expect(result.artifacts.accessibilitySnapshots.some((entry: any) => entry.path.endsWith("owned-page.accessibility.json"))).toBe(true);
		const performance = result.artifacts.traces.find((entry: any) => entry.path.endsWith("owned-performance.json"));
		expect(performance).toBeDefined();
		if (!performance) throw new Error("expected sanitized performance evidence");
		expect(fs.existsSync(path.join(evidenceDir, "owned-performance.raw.json"))).toBe(false);
		const performanceSummary = fs.readFileSync(performance.path, "utf8");
		expect(performanceSummary).not.toContain("token=secret");
		expect(performanceSummary).toContain('"lcpMs": 217');
		expect(performanceSummary).toContain('"cls": 0.03');
		expect(performanceSummary).toContain("LCPBreakdown");
		const calls = fs.readFileSync(path.join(project, "fake-chrome-devtools.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const start = calls.find((entry) => entry[0] === "start");
		const stop = calls.find((entry) => entry[0] === "stop");
		expect(start).toBeDefined();
		expect(stop).toBeDefined();
		const sessionFlag = start.indexOf("--sessionId");
		expect(sessionFlag).toBeGreaterThanOrEqual(0);
		const sessionId = start[sessionFlag + 1];
		expect(sessionId).toMatch(/^[a-f0-9]{32}$/);
		expect(stop).toContain(sessionId);
		expect(start).toContain("--javascriptEvaluation=false");
		expect(start).toContain("--redactNetworkHeaders=true");
	});

	test("preserves the browser backend's bounded in-memory upload flow size", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		writeFlow(uiWorkspace, "browser-upload.jsonc", {
			version: 1,
			target: { url: "https://example.test/upload" },
			steps: [{
				action: "uploadFiles",
				locator: { testId: "file" },
				files: [{ name: "fixture.bin", mimeType: "application/octet-stream", base64: "A".repeat(1_100_000) }],
			}],
		});
		const result = invoke(project, agentDir, ["probe", "--flow", "browser-upload.jsonc"], 30_000);
		expectRunnerStatus(result, 0);
		expect(result.payload.status).toBe("AVAILABLE");
		expect(result.payload.selection.selectedBackend).toBe("browser");
	});

	test("preserves redacted browser credential update metadata", async () => {
		const { project, agentDir } = createProject();
		const fakeRunner = writeProjectFile(project, "fake-browser-runner.mjs", `
console.log(JSON.stringify({
  status: "QA_AUTH_UPDATE_REQUIRED",
  profile: "staging-admin",
  file: ".pi/qa_auth.jsonc",
  reason: "credentials are required",
  action: "fill_credentials",
  templateCreated: false,
  placeholderCount: 2
}));
process.exitCode = 2;
`);
		const result = await runBrowserBackend({
			flow: {
				target: { profile: "staging-admin" },
				steps: [{ action: "assertVisible", locator: { testId: "account" } }],
			},
			projectRoot: project,
			agentDir,
			runId: "auth-update",
			deadline: Date.now() + 10_000,
			browserRunnerPath: fakeRunner,
			progress() {},
		});
		expect(result.status).toBe("BLOCKED");
		expect(result.profile).toBe("staging-admin");
		expect(result.file).toBe(".pi/qa_auth.jsonc");
		expect(result.action).toBe("fill_credentials");
		expect(result.templateCreated).toBe(false);
		expect(result.placeholderCount).toBe(2);
	});

	test("drives a real alternate-screen TUI through PTY input and screen assertions", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		writeProjectFile(project, "fixture.mjs", `
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdout.write("\\u001b[?1049h\\u001b[2J\\u001b[HReady\\r\\nPress enter");
process.stdin.on("data", (data) => {
  if (data.includes("\\r")) process.stdout.write("\\u001b[2J\\u001b[HAccepted\\r\\nDone");
});
`);
		writeFlow(uiWorkspace, "tui.jsonc", {
			version: 1,
			target: { command: { argv: [nodeExecutable, "fixture.mjs"], cwd: "." } },
			viewport: { cols: 40, rows: 10 },
			steps: [
				{ action: "waitForText", text: "Ready" },
				{ action: "sendKeys", keys: ["enter"] },
				{ action: "waitForText", text: "Accepted" },
				{ action: "waitForStable", settleMs: 100 },
				{ action: "assertText", text: "Accepted" },
				{ action: "assertNotText", text: "Ready" },
				{ action: "assertProcessRunning" },
				{ action: "capture", name: "accepted" },
			],
		});
		const result = invoke(project, agentDir, ["run", "--flow", "tui.jsonc", "--run-id", "interactive", "--runner-timeout-ms", "10000"]);
		expectRunnerStatus(result, 0);
		expect(result.payload.status).toBe("PASSED");
		expect(result.payload.selection.selectedBackend).toBe("tui");
		expect(result.payload.selection.guide).toEqual({ backend: "tui", topic: "pty" });
		expect(result.payload.assertions.every((entry: any) => entry.passed)).toBe(true);
		expect(result.payload.artifacts.terminalCaptures.length).toBeGreaterThanOrEqual(5);
		const snapshot = JSON.parse(fs.readFileSync(result.payload.artifacts.terminalCaptures.find((entry: any) => entry.path.endsWith("accepted.screen.json")).path, "utf8"));
		expect(snapshot.bufferType).toBe("alternate");
		expect(snapshot.text).toContain("Accepted");
		expect(snapshot.text).not.toContain("Ready");
	});

	test("advertises terminalRecording as a TUI capability", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		writeProjectFile(project, "fixture.mjs", "setInterval(() => {}, 1000);\n");
		writeFlow(uiWorkspace, "tui-capabilities.jsonc", { target: { command: { argv: [nodeExecutable, "fixture.mjs"] } } });
		const result = invoke(project, agentDir, ["probe", "--flow", "tui-capabilities.jsonc"]);
		expectRunnerStatus(result, 0);
		expect(result.payload.status).toBe("AVAILABLE");
		expect(result.payload.selection.selectedBackend).toBe("tui");
		expect(result.payload.selection.guide).toEqual({ backend: "tui", topic: "pty" });
		expect(result.payload.selection.supportedCapabilities).toContain("terminalRecording");
		expect(result.payload.selection.missingCapabilities).not.toContain("terminalRecording");
	});

	test("keeps PTY presentation as the backward-compatible default and makes native terminal explicit", () => {
		expect(resolveTuiPresentation({ target: { command: { argv: ["node", "fixture.mjs"] } } })).toBe("pty");
		expect(resolveTuiPresentation({ target: { command: { argv: ["node", "fixture.mjs"], presentation: "native-terminal" } } })).toBe("native-terminal");
		expect(() => resolveTuiPresentation({ target: { command: { argv: ["node", "fixture.mjs"], presentation: "project-specific" } } })).toThrow(/presentation/);
	});

	test("uses signal-less node-pty termination and releases Windows ConPTY handles", async () => {
		const killArgs: unknown[][] = [];
		let inputDestroyed = 0;
		let outputDestroyed = 0;
		let disposed = 0;
		let workerTerminated = 0;
		const processHandle = {
			kill: (...args: unknown[]) => { killArgs.push(args); },
			_agent: {
				inSocket: { destroy: () => { inputDestroyed += 1; } },
				outSocket: { destroy: () => { outputDestroyed += 1; } },
				_conoutSocketWorker: {
					dispose: () => { disposed += 1; },
					_worker: { terminate: async () => { workerTerminated += 1; } },
				},
			},
		};

		terminateOwnedPty(processHandle, "SIGTERM", "win32");
		await releaseWindowsPtyResources(processHandle, "win32");

		expect(killArgs).toEqual([[]]);
		expect(inputDestroyed).toBe(1);
		expect(outputDestroyed).toBe(1);
		expect(disposed).toBe(1);
		expect(workerTerminated).toBe(1);
	});

	test("routes explicit native-terminal presentation through the generic TUI backend", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		writeProjectFile(project, "fixture.mjs", "setInterval(() => {}, 1000);\n");
		writeFlow(uiWorkspace, "native-terminal-probe.jsonc", {
			target: { command: { argv: [nodeExecutable, "fixture.mjs"], presentation: "native-terminal" } },
		});
		const result = invoke(project, agentDir, ["probe", "--flow", "native-terminal-probe.jsonc", "--runner-timeout-ms", "30000"], 40_000);
		expect(result.payload.selection.selectedBackend).toBe("tui");
		expect(result.payload.selection.guide).toEqual({ backend: "tui", topic: "native-terminal" });
		const tui = result.payload.selection.candidateBackends.find((entry: any) => entry.backend === "tui");
		expect(tui.eligible).toBe(true);
		if (process.platform === "darwin") {
			expect(["macos-iterm2-window", "macos-terminal-window"]).toContain(tui.platformDriver);
		} else if (process.platform === "win32") {
			expect(["windows-terminal-window"]).toContain(tui.platformDriver);
		} else if (process.platform === "linux") {
			expect(tui.platformDriver).toMatch(/^linux-/);
		}
		if (result.payload.status === "AVAILABLE") {
			expect(result.status).toBe(0);
			expect(result.payload.selection.supportedCapabilities).toContain("nativeTerminalWindow");
			expect(result.payload.selection.supportedCapabilities).toContain("windowScreenshot");
		} else {
			expect(result.status).toBe(2);
			expect(result.payload.status).toBe("BLOCKED");
			expect(result.payload.blockedHandoff).toBeDefined();
		}
	});

	test("native-terminal bootstrap contains only the trusted bridge command, never target argv", () => {
		const command = nativeTerminalBridgeShellCommand({
			nodePath: "/opt/runtime/node",
			bridgePath: "/opt/ui qa/bridge-client.mjs",
			port: 4242,
			token: "a".repeat(64),
		});
		const commandFile = nativeTerminalBridgeCommandFile({ command });
		expect(command).toStartWith("exec ");
		expect(command).toContain("'/opt/runtime/node'");
		expect(command).toContain("'/opt/ui qa/bridge-client.mjs'");
		expect(command).toContain("--port 4242 --token");
		expect(command).not.toContain("app.mjs");
		expect(command).not.toContain("project");
		expect(commandFile).toBe(`#!/bin/zsh\n${command}\n`);
	});

	test("native-terminal selects native hosts by platform capability rather than project identity", () => {
		expect(chooseNativeTerminalProvider({ platform: "darwin", itermAvailable: true, terminalAvailable: true })).toMatchObject({
			id: "iterm2",
			platformDriver: "macos-iterm2-window",
			commandFile: false,
		});
		expect(chooseNativeTerminalProvider({ platform: "darwin", itermAvailable: false, terminalAvailable: true })).toMatchObject({
			id: "terminal-app",
			platformDriver: "macos-terminal-window",
			commandFile: true,
		});
		expect(chooseNativeTerminalProvider({ platform: "win32", windowsTerminalAvailable: true, windowsTerminalExecutable: "C:\\wt.exe" })).toMatchObject({
			id: "windows-terminal",
			platformDriver: "windows-terminal-window",
			evidenceSelector: "title",
		});
		expect(chooseNativeTerminalProvider({ platform: "linux", kittyAvailable: true, alacrittyAvailable: true })).toMatchObject({
			id: "kitty",
			platformDriver: "linux-kitty-window",
		});
		expect(chooseNativeTerminalProvider({ platform: "linux", gnomeTerminalAvailable: true })).toMatchObject({
			id: "gnome-terminal",
			platformDriver: "linux-gnome-terminal-window",
		});
		expect(chooseNativeTerminalProvider({ platform: "linux" })).toBeNull();
	});

	test("native-terminal direct providers launch only the trusted bridge and a unique evidence title", () => {
		const token = "a".repeat(64);
		const title = "Pi UI QA cross-platform deadbeef";
		const common = { nodePath: "/runtime/node", bridgePath: "/trusted/bridge-client.mjs", port: 4242, token, title };
		const windows = chooseNativeTerminalProvider({ platform: "win32", windowsTerminalAvailable: true, windowsTerminalExecutable: "C:\\wt.exe" });
		const linux = chooseNativeTerminalProvider({ platform: "linux", alacrittyAvailable: true, alacrittyExecutable: "/usr/bin/alacritty" });
		for (const provider of [windows, linux]) {
			const args = nativeTerminalProviderLaunchArgs(provider, common);
			expect(args).toContain(title);
			expect(args).toContain("/runtime/node");
			expect(args).toContain("/trusted/bridge-client.mjs");
			expect(args).toContain(token);
			expect(args.join(" ")).not.toContain("target-app");
		}
	});

	test("native-terminal keeps PTY semantic oracles but rejects dishonest PTY-only resizing", () => {
		const allowed = [
			{ action: "waitForText", text: "Ready" },
			{ action: "sendText", text: "hello" },
			{ action: "sendKeys", keys: ["enter"] },
			{ action: "assertCursor", row: 1, column: 1 },
			{ action: "assertProcessRunning" },
			{ action: "assertProcessExited", exitCode: 0 },
			{ action: "capture", name: "visual" },
		];
		expect(validateNativeTerminalSteps(allowed)).toBe(allowed);
		expect(() => validateNativeTerminalSteps([{ action: "resize", cols: 80, rows: 24 }])).toThrow(/PTY-only/);
	});

	test("native-terminal bridge bootstrap validates its fixed transport parameters", () => {
		expect(() => nativeTerminalBridgeShellCommand({ nodePath: "/node", bridgePath: "/bridge", port: 0, token: "a".repeat(64) })).toThrow(/port/);
		expect(() => nativeTerminalBridgeShellCommand({ nodePath: "/node", bridgePath: "/bridge", port: 4242, token: "not-secret" })).toThrow(/token/);
		expect(() => nativeTerminalBridgeShellCommand({ nodePath: "/bad\nnode", bridgePath: "/bridge", port: 4242, token: "a".repeat(64) })).toThrow(/path/);
		expect(() => nativeTerminalBridgeShellCommand({ nodePath: "/node", bridgePath: "/bridge", port: 4242, token: "a".repeat(64), title: "bad\ntitle" })).toThrow(/title/);
		expect(() => nativeTerminalBridgeCommandFile({ command: "node arbitrary-target.mjs" })).toThrow(/command/);
	});

	test("records a bounded asciicast v2 terminal video under the evidence directory", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		writeProjectFile(project, "fixture.mjs", `
process.stdin.setRawMode?.(true);
process.stdout.write("\\u001b[?1049h\\u001b[2J\\u001b[HReady\\r\\nPress enter");
process.stdin.on("data", (data) => {
  if (data.includes("\\r")) process.stdout.write("\\u001b[2J\\u001b[HAccepted\\r\\nDone");
});
`);
		writeFlow(uiWorkspace, "recording.jsonc", {
			version: 1,
			target: { command: { argv: [nodeExecutable, "fixture.mjs"], cwd: "." } },
			viewport: { cols: 40, rows: 10 },
			steps: [
				{ action: "waitForText", text: "Ready" },
				{ action: "resize", cols: 60, rows: 12 },
				{ action: "sendKeys", keys: ["enter"] },
				{ action: "waitForText", text: "Accepted" },
				{ action: "assertText", text: "Accepted" },
			],
		});
		const result = invoke(project, agentDir, ["run", "--flow", "recording.jsonc", "--run-id", "recording", "--runner-timeout-ms", "10000"]);
		expectRunnerStatus(result, 0);
		expect(result.payload.status).toBe("PASSED");
		expect(result.payload.selection.supportedCapabilities).toContain("terminalRecording");
		expect(result.payload.artifacts.videos).toHaveLength(1);
		const video = result.payload.artifacts.videos[0];
		expect(video.format).toBe("asciicast-v2");
		expect(video.truncated).toBe(false);
		expect(video.path.endsWith("terminal-recording.cast")).toBe(true);
		expect(video.path.startsWith(path.join(project, ".pi", "subagents", "run", "qa", "ui-qa", "evidence", "recording"))).toBe(true);
		const stat = fs.statSync(video.path);
		expect(stat.isFile()).toBe(true);
		if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
		const { header, events } = readAsciicast(video.path);
		expect(header.version).toBe(2);
		expect(header.width).toBe(40);
		expect(header.height).toBe(10);
		expect(header.env.TERM).toBe("xterm-256color");
		expect(events).toHaveLength(video.events);
		expect(events.length).toBeGreaterThan(0);
		expect(events.every((event: any) => Array.isArray(event) && event.length === 3 && typeof event[0] === "number" && ["o", "r"].includes(event[1]))).toBe(true);
		for (let index = 1; index < events.length; index += 1) {
			expect(events[index][0]).toBeGreaterThanOrEqual(events[index - 1][0]);
		}
		expect(events.some((event: any) => event[1] === "r" && event[2] === "60x12")).toBe(true);
		const output = events.filter((event: any) => event[1] === "o").map((event: any) => event[2]).join("");
		expect(output).toContain("Ready");
		expect(output).toContain("Accepted");
		const observation = result.payload.observations.find((entry: any) => entry.action === "terminalRecording");
		expect(observation).toMatchObject({ status: "recorded", truncated: false });
	});

	test("bounds the terminal recording to the transcript limit without failing the run", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		writeProjectFile(project, "flooding.mjs", `
const chunk = "x".repeat(64 * 1024);
for (let index = 0; index < 20; index += 1) process.stdout.write(chunk);
process.stdout.write("\\nREADY\\nDONE\\n");
`);
		writeFlow(uiWorkspace, "flood.jsonc", {
			target: { command: { argv: [nodeExecutable, "flooding.mjs"] } },
			steps: [
				{ action: "waitForText", text: "DONE", timeoutMs: 10_000 },
				{ action: "assertText", text: "DONE" },
				{ action: "assertText", text: "READY" },
			],
		});
		const result = invoke(project, agentDir, ["run", "--flow", "flood.jsonc", "--run-id", "flood", "--runner-timeout-ms", "15000"]);
		expect(result.status).toBe(0);
		expect(result.payload.status).toBe("PASSED");
		expect(result.payload.assertions.every((entry: any) => entry.passed)).toBe(true);
		expect(result.payload.artifacts.videos).toHaveLength(1);
		const video = result.payload.artifacts.videos[0];
		expect(video.format).toBe("asciicast-v2");
		expect(video.truncated).toBe(true);
		expect(fs.statSync(video.path).size).toBeLessThanOrEqual(1024 * 1024);
	});

	test("models cursor movement, erase operations, and resize as terminal state", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		writeProjectFile(project, "ansi-fixture.mjs", `
process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdout.write("Old text\\u001b[H\\u001b[2KNew text");
process.stdin.on("data", (data) => {
  if (data.includes("s")) process.stdout.write("\\u001b[2;1HSIZE=" + process.stdout.columns + "x" + process.stdout.rows);
});
`);
		writeFlow(uiWorkspace, "ansi.jsonc", {
			target: { command: { argv: [nodeExecutable, "ansi-fixture.mjs"] } },
			steps: [
				{ action: "waitForText", text: "New text" },
				{ action: "assertNotText", text: "Old text" },
				{ action: "assertCursor", row: 1, column: 9 },
				{ action: "resize", cols: 50, rows: 12 },
				{ action: "sendText", text: "s" },
				{ action: "waitForText", text: "SIZE=50x12" },
				{ action: "assertText", text: "SIZE=50x12" },
			],
		});
		const result = invoke(project, agentDir, ["run", "--flow", "ansi.jsonc", "--run-id", "ansi", "--runner-timeout-ms", "10000"]);
		expect(result.status).toBe(0);
		expect(result.payload.status).toBe("PASSED");
		expect(result.payload.assertions).toHaveLength(3);
	});

	test("does not retain the exit assertion timeout after the PTY exits", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		writeProjectFile(project, "exit-fixture.mjs", `
process.stdout.write("exiting");
setTimeout(() => process.exit(7), 50);
`);
		writeFlow(uiWorkspace, "exit.jsonc", {
			target: { command: { argv: [nodeExecutable, "exit-fixture.mjs"] } },
			steps: [
				{ action: "waitForText", text: "exiting" },
				{ action: "assertProcessExited", exitCode: 7, timeoutMs: 5_000 },
			],
		});
		const started = Date.now();
		const result = invoke(project, agentDir, ["run", "--flow", "exit.jsonc", "--run-id", "exit", "--runner-timeout-ms", "6000"], 10_000);
		expect(result.status).toBe(0);
		expect(result.payload.status).toBe("PASSED");
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	test("cleanup terminates its PTY but leaves an unrelated process alive", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		writeProjectFile(project, "long-running.mjs", `
process.stdin.setRawMode?.(true);
process.stdout.write("running");
setInterval(() => {}, 1000);
`);
		writeFlow(uiWorkspace, "cleanup.jsonc", {
			target: { command: { argv: [nodeExecutable, "long-running.mjs"] } },
			steps: [{ action: "waitForText", text: "running" }, { action: "assertProcessRunning" }],
		});
		const unrelated = spawn(nodeExecutable, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		children.push(unrelated);
		const result = invoke(project, agentDir, ["run", "--flow", "cleanup.jsonc", "--run-id", "cleanup", "--runner-timeout-ms", "5000"]);
		expect(result.payload.status).toBe("PASSED");
		expect(unrelated.pid).toBeDefined();
		expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
	});

	test("rejects shell, generic utility, inline-code, and untrusted environment launch primitives", () => {
		for (const [name, command] of [
			["shell", { argv: ["sh", "-c", "echo pwned"] }],
			["utility", { argv: ["/bin/cat", "/etc/passwd"] }],
			["inline", { argv: ["node", "-e", "console.log('pwned')"] }],
			["env", { argv: [nodeExecutable, "fixture.mjs"], env: { SECRET: "read-me" } }],
		] as const) {
			const { project, agentDir, uiWorkspace } = createProject();
			writeProjectFile(project, "fixture.mjs", "setInterval(() => {}, 1000);\n");
			writeFlow(uiWorkspace, `${name}.jsonc`, { target: { command }, steps: [{ action: "assertProcessRunning" }] });
			const result = invoke(project, agentDir, ["run", "--flow", `${name}.jsonc`, "--run-id", name, "--runner-timeout-ms", "2000"]);
			expect(result.status).toBe(1);
			expect(result.payload.status).toBe("FAILED");
			expect(result.payload.reason).toMatch(/shell|project|inline|environment|env key|scripting/i);
		}
	});

	test("rejects flow and launch paths that escape or symlink outside the owning workspace", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		const outside = path.join(project, "outside.jsonc");
		fs.writeFileSync(outside, JSON.stringify({ target: { url: "https://example.test" } }), { mode: 0o600 });
		const escaped = invoke(project, agentDir, ["probe", "--flow", "../../../outside.jsonc"]);
		expect(escaped.status).toBe(1);
		expect(escaped.payload.reason).toContain("owning workspace");

		if (process.platform !== "win32") {
			const link = path.join(uiWorkspace, "flows", "link.jsonc");
			fs.symlinkSync(outside, link);
			const linked = invoke(project, agentDir, ["probe", "--flow", "link.jsonc"]);
			expect(linked.status).toBe(1);
			expect(linked.payload.reason).toMatch(/symbolic|workspace/);
		}

		writeProjectFile(project, "fixture.mjs", "setInterval(() => {}, 1000);\n");
		writeFlow(uiWorkspace, "cwd.jsonc", { target: { command: { argv: [nodeExecutable, "fixture.mjs"], cwd: ".." } }, steps: [{ action: "assertProcessRunning" }] });
		const cwdEscape = invoke(project, agentDir, ["run", "--flow", "cwd.jsonc", "--run-id", "cwd", "--runner-timeout-ms", "2000"]);
		expect(cwdEscape.status).toBe(1);
		expect(cwdEscape.payload.reason).toContain("project-local");

		if (process.platform !== "win32") {
			const progressTarget = path.join(project, "outside-progress.jsonl");
			fs.writeFileSync(progressTarget, "unchanged\n", { mode: 0o600 });
			writeFlow(uiWorkspace, "valid.jsonc", { target: { url: "https://example.test" } });
			fs.rmSync(path.join(uiWorkspace, "progress.jsonl"), { force: true });
			fs.symlinkSync(progressTarget, path.join(uiWorkspace, "progress.jsonl"));
			const progressLink = invoke(project, agentDir, ["probe", "--flow", "valid.jsonc"]);
			expect(progressLink.status).toBe(1);
			expect(progressLink.payload.reason).toContain("progress path");
			expect(fs.readFileSync(progressTarget, "utf8")).toBe("unchanged\n");
		}
	});

	test("bounds action and runner timeouts", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		writeProjectFile(project, "changing.mjs", "let i=0; setInterval(() => process.stdout.write(`\\r${++i}`), 10);\n");
		writeFlow(uiWorkspace, "action-timeout.jsonc", {
			target: { command: { argv: [nodeExecutable, "changing.mjs"] } },
			steps: [{ action: "waitForText", text: "1" }, { action: "waitForStable", settleMs: 100, timeoutMs: 150 }],
		});
		const action = invoke(project, agentDir, ["run", "--flow", "action-timeout.jsonc", "--run-id", "action-timeout", "--runner-timeout-ms", "2000"]);
		expectRunnerStatus(action, 1);
		expect(action.payload.reason).toContain("did not settle");

		writeFlow(uiWorkspace, "runner-timeout.jsonc", {
			target: { command: { argv: [nodeExecutable, "changing.mjs"] } },
			steps: [{ action: "waitForText", text: "1" }, { action: "waitForStable", settleMs: 100, timeoutMs: 30000 }],
		});
		const overall = invoke(project, agentDir, ["run", "--flow", "runner-timeout.jsonc", "--run-id", "runner-timeout", "--runner-timeout-ms", "100"]);
		expectRunnerStatus(overall, 124);
		expect(overall.payload.timedOut).toBe(true);
	});

	test("hard timeout leaves backend cleanup time to kill a SIGTERM-resistant PTY", () => {
		const { project, agentDir, uiWorkspace } = createProject();
		writeProjectFile(project, "resistant.mjs", `
process.on("SIGTERM", () => {});
process.on("SIGHUP", () => {});
process.stdout.write("running");
let i = 0;
setInterval(() => process.stdout.write("\\r" + (++i)), 10);
`);
		writeFlow(uiWorkspace, "resistant.jsonc", {
			target: { command: { argv: [nodeExecutable, "resistant.mjs"] } },
			steps: [{ action: "waitForText", text: "running" }, { action: "waitForStable", settleMs: 100, timeoutMs: 30_000 }],
		});
		const started = Date.now();
		const result = invoke(project, agentDir, ["run", "--flow", "resistant.jsonc", "--run-id", "resistant", "--runner-timeout-ms", "100"], 12_000);
		expectRunnerStatus(result, 124);
		expect(result.payload.timedOut).toBe(true);
		expect(Date.now() - started).toBeLessThan(8_000);
		const pid = result.payload.observations?.find((entry: any) => entry.action === "launch")?.pid;
		expect(pid).toBeNumber();
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("returns deterministic desktop platform capabilities and structured blockers", () => {
		const windows = desktopPlatformContract("win32");
		const linux = desktopPlatformContract("linux");
		const unsupported = desktopPlatformContract("freebsd");
		expect(windows.available).toBe(true);
		expect(windows.platformDriver).toBe("windows-uia");
		expect(windows.reason).toContain("UI Automation");
		expect(linux.available).toBe(true);
		expect(linux.platformDriver).toBe("linux-at-spi");
		expect(linux.reason).toContain("AT-SPI");
		expect(unsupported.available).toBe(false);
		expect(unsupported.missingCapabilities).toContain("semanticAccessibility");

		const { project, agentDir, uiWorkspace } = createProject();
		writeFlow(uiWorkspace, "desktop.jsonc", { target: { application: { name: "Nonexistent UI QA Fixture" } } });
		const first = invoke(project, agentDir, ["probe", "--flow", "desktop.jsonc", "--runner-timeout-ms", "30000"], 40_000);
		const second = invoke(project, agentDir, ["probe", "--flow", "desktop.jsonc", "--runner-timeout-ms", "30000"], 40_000);
		expect(first.payload.selection.selectedBackend).toBe("desktop");
		expect(second.payload.selection.selectedBackend).toBe("desktop");
		const expectedDesktopTopic = process.platform === "darwin"
			? "macos-accessibility"
			: process.platform === "win32"
				? "windows-uia"
				: process.platform === "linux"
					? "linux-at-spi"
					: undefined;
		if (expectedDesktopTopic) {
			expect(first.payload.selection.guide).toEqual({ backend: "desktop", topic: expectedDesktopTopic });
			expect(second.payload.selection.guide).toEqual({ backend: "desktop", topic: expectedDesktopTopic });
		}
		expect(second.payload.status).toBe(first.payload.status);
		expect(second.payload.selection.supportedCapabilities).toEqual(first.payload.selection.supportedCapabilities);
		// Exact-window video additionally requires ScreenCaptureKit, so it may be
		// stricter than screenshots but can never be advertised without them.
		if (first.payload.selection.supportedCapabilities.includes("windowVideo")) {
			expect(first.payload.selection.supportedCapabilities).toContain("windowScreenshot");
		}
		if (first.payload.status === "BLOCKED") {
			expect(first.status).toBe(2);
			expect(first.payload.reason).toBeString();
			expect(first.payload.remediation).toBeString();
		}
		expectUnifiedArtifacts(first.payload);
	});

	test("returns a parent-ready remediation handoff when a required backend is blocked", () => {
		// Windows needs a valid SystemRoot to start Node itself, while the same
		// SystemRoot also exposes the trusted PowerShell UIA helper. Forcing it to
		// a fake path crashes the runner before it can report a structured blocker,
		// so exercise the deterministic forced-block path on POSIX. Windows still
		// covers its real probe contract and blocked shape when the helper is absent.
		if (process.platform === "win32") return;
		const { project, agentDir, uiWorkspace } = createProject();
		writeFlow(uiWorkspace, "blocked-desktop.jsonc", {
			target: { application: { name: "Unavailable UI QA target" } },
			steps: [{ action: "waitForWindow" }],
		});
		// Removing PATH removes the required trusted helper runtime/toolchain on each
		// supported desktop platform. The runner must return the same parent-facing
		// BLOCKED handoff shape without attempting remediation.
		const blockedEnvironment: Record<string, string> = { PATH: "" };
		for (const args of [
			["probe", "--flow", "blocked-desktop.jsonc", "--runner-timeout-ms", "30000"],
			["run", "--flow", "blocked-desktop.jsonc", "--run-id", "blocked-handoff", "--runner-timeout-ms", "30000"],
		]) {
			const result = invoke(project, agentDir, args, 40_000, blockedEnvironment);
			expect(result.status).toBe(2);
			expect(result.payload.status).toBe("BLOCKED");
			expect(result.payload.selection.selectedBackend).toBe("desktop");
			expect(result.payload.selection.platformDriver).toBeString();
			expect(result.payload.blockedHandoff).toEqual({
				backend: "desktop",
				platformDriver: result.payload.selection.platformDriver,
				missingCapabilities: result.payload.selection.missingCapabilities,
				reason: result.payload.reason,
				remediation: result.payload.remediation,
				manualActionRequired: true,
				automaticRemediationAttempted: false,
			});
			expect(result.payload.remediation).toBeString();
		}
	});

	test("gates desktop capture steps on honestly probed capabilities", () => {
		const full = ["windowScreenshot", "windowVideo", "semanticActivation", "valueInput", "keyboardInput", "stateAssertions"];
		expect(validateDesktopStepCapabilities({ action: "screenshot", name: "shot" }, full)).toBeDefined();
		expect(validateDesktopStepCapabilities({ action: "activate" }, full)).toBeDefined();
		expect(validateDesktopStepCapabilities({ action: "inputText" }, full)).toBeDefined();
		// Screenshot-only producers still reject every capture-shape step.
		expect(() => validateDesktopStepCapabilities({ action: "screenshot" }, [])).toThrow(/windowScreenshot/);
		expect(() => validateDesktopStepCapabilities({ action: "capture" }, [])).toThrow(/windowScreenshot/);
		expect(() => validateDesktopStepCapabilities({ action: "activate" }, [])).toThrow(/semanticActivation/);
		expect(() => validateDesktopStepCapabilities({ action: "setValue" }, [])).toThrow(/valueInput/);
		expect(() => validateDesktopStepCapabilities({ action: "inputText" }, [])).toThrow(/keyboardInput/);
	});

	test("uses process-group selectors for POSIX launches and owned process-tree roots on Windows", () => {
		expect(launchedApplicationSelector({ pid: 4242 }, "darwin")).toEqual(["--pgid", "4242"]);
		expect(launchedApplicationSelector({ pid: 4242 }, "linux")).toEqual(["--pgid", "4242"]);
		expect(launchedApplicationSelector({ pid: 4242 }, "win32")).toEqual(["--owner-pid", "4242"]);
	});

	test("bundles capability-probed Windows UIA and Linux AT-SPI desktop helpers without shell evaluation", () => {
		const windows = fs.readFileSync(windowsDesktopDriverSource, "utf8");
		const linux = fs.readFileSync(linuxDesktopDriverSource, "utf8");
		expect(windows).toContain("uia=available");
		expect(windows).toContain("screenshot=available");
		expect(windows).toContain('"owner-pid"');
		expect(windows).toContain('"screenshot"');
		expect(windows).not.toContain("Invoke-Expression");
		expect(linux).toContain("atspi=available");
		expect(linux).toContain("keyboard_input=");
		expect(linux).toContain("pyatspi.Registry");
		expect(linux).not.toContain("shell=True");
	});

	test("scales independent-window video to fill its Retina output surface", () => {
		const source = fs.readFileSync(macosDesktopDriverSource, "utf8");
		const start = source.indexOf("func recordWindowVideo");
		const end = source.indexOf("private func evenPixel", start);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const recorder = source.slice(start, end);
		expect(recorder).toContain("SCContentFilter(desktopIndependentWindow: target)");
		expect(recorder).toContain("configuration.scalesToFit = true");
	});

	test("targets and cleans a package-wrapper GUI descendant through its owned POSIX group", async () => {
		if (process.platform === "win32") return;
		const { project } = createProject();
		const descendantPidFile = path.join(project, "descendant.pid");
		writeProjectFile(project, "package-wrapper.mjs", `
import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(child.pid));
process.exit(0);
`);
		const wrapper = spawn(nodeExecutable, ["package-wrapper.mjs", descendantPidFile], {
			cwd: project,
			detached: true,
			stdio: "ignore",
		});
		try {
			await waitUntil(() => fs.existsSync(descendantPidFile));
			const descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
			expect(descendantPid).toBeGreaterThan(0);
			if (wrapper.exitCode === null && wrapper.signalCode === null) await new Promise<void>((resolve) => wrapper.once("exit", () => resolve()));
			expect(launchedApplicationSelector(wrapper)).toEqual(["--pgid", String(wrapper.pid)]);
			expect(() => process.kill(descendantPid, 0)).not.toThrow();
			expect(() => process.kill(-wrapper.pid!, 0)).not.toThrow();
			await terminateOwnedProcessTree(wrapper);
			await waitUntil(() => {
				try { process.kill(descendantPid, 0); return false; } catch { return true; }
			});
		} finally {
			await terminateOwnedProcessTree(wrapper);
		}
	});
});
