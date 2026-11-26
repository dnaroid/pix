import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { probeBrowserBackend, runBrowserBackend } from "../../src/async-subagents/agents/ui-qa/backends/browser.mjs";
import { compileBrowserFlow, pageSource } from "../../src/async-subagents/agents/ui-qa/drivers/chrome-control/flow.mjs";

const origin = "https://example.test";
const instance = { pid: 123, started: 400 };
const target = { url: `${origin}/start` };
const assertURL = { action: "assertURL", includes: "/start" };
const jxa = fs.readFileSync(new URL("../../src/async-subagents/agents/ui-qa/drivers/chrome-control/chrome.jxa.js", import.meta.url), "utf8");
const temp: string[] = [];
afterEach(() => {
	for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Request = { command: string; source?: string; url?: string; marker?: string; tabId?: number; instance?: typeof instance; file?: string; interaction?: boolean };

function mockRun(steps: object[], intercept?: (request: Request) => object | undefined) {
	const calls: Request[] = [];
	const evidenceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrome-control-test-")));
	temp.push(evidenceDir);
	const context = {
		flow: { target, steps }, evidenceDir, deadline: Date.now() + 10_000,
		artifact(file: string) { return { path: file, uri: pathToFileURL(file).href }; },
		async chrome(request: Request) {
			calls.push(request);
			const override = intercept?.(request);
			if (override) return override;
			switch (request.command) {
				case "probe": return { code: "ok", instance, screenshot: true };
				case "open": return { code: "ok", tabId: 23 };
				case "page": return { code: "ok", value: "ok" };
				case "screenshot": fs.writeFileSync(request.file!, "fixture"); break;
			}
			return { code: "ok" };
		},
	};
	return { context, calls };
}

test("probe selects only Chrome Control and does not launch or navigate", async () => {
	const { context, calls } = mockRun([assertURL]);
	const unavailable = await probeBrowserBackend({ ...context, platform: "linux" });
	expect(unavailable).toMatchObject({ available: false, platformDriver: "chrome-control", missingCapabilities: ["macosChrome"] });
	expect(calls).toEqual([]);
	const granted = await probeBrowserBackend({ ...context, platform: "darwin" });
	expect(granted).toMatchObject({ available: true, platformDriver: "chrome-control" });
	expect(calls).toEqual([{ command: "probe" }]);
});

test("rejects legacy isolation and auth contracts before talking to Chrome", async () => {
	const { context, calls } = mockRun([assertURL]);
	for (const legacy of [{ profile: "qa" }, { browserDriver: "playwright" }, { devtools: { headless: true } }, { allowedOrigins: [origin] }]) {
		const flow = { ...context.flow, target: { ...target, ...legacy } };
		expect(await probeBrowserBackend({ ...context, flow, platform: "darwin" })).toMatchObject({ available: false, missingCapabilities: ["chromeControlFlow"] });
	}
	expect(calls).toEqual([]);
	expect(compileBrowserFlow({ target, steps: [{ action: "goto", url: "https://other.test" }] })).toHaveProperty("unsupported");
	expect(() => compileBrowserFlow({ target: { url: "https://user:pw@example.test" }, steps: [assertURL] })).toThrow("without credentials");
});

test("screenshots require capability and rejected capture is never published", async () => {
	const { context, calls } = mockRun([{ action: "screenshot" }], (request) => {
		if (request.command === "screenshot") {
			expect(path.relative(context.evidenceDir, request.file!)).toMatch(/^\.\./);
			fs.writeFileSync(request.file!, "unverified pixels");
			return { code: "window-unavailable" };
		}
	});
	expect(await probeBrowserBackend({ ...context, platform: "darwin", chrome: async () => ({ code: "ok", instance, screenshot: false }) }))
		.toMatchObject({ available: false, missingCapabilities: ["screenRecording"] });
	expect(await runBrowserBackend(context)).toMatchObject({ status: "BLOCKED", artifacts: { screenshots: [] } });
	expect(fs.readdirSync(context.evidenceDir)).toEqual([]);
	expect(fs.existsSync(path.dirname(calls.find((request) => request.command === "screenshot")!.file!))).toBe(false);
	expect(calls[calls.length - 1]).toMatchObject({ command: "close", tabId: 23, instance });
});

test("owned tab, stable screenshot names and assertion results are preserved", async () => {
	const { context, calls } = mockRun([assertURL, { action: "screenshot" }, { action: "screenshot" }]);
	const outcome = await runBrowserBackend(context);
	expect(outcome).toMatchObject({ status: "PASSED", assertions: [{ action: "assertURL", passed: true }] });
	if (!("artifacts" in outcome)) throw new Error("expected Chrome Control screenshot artifacts");
	expect(outcome.artifacts.screenshots.map((item: { path: string }) => path.basename(item.path))).toEqual(["002-chrome.png", "003-chrome.png"]);
	expect(calls[1]).toMatchObject({ command: "open", instance, marker: expect.stringMatching(/^about:blank#pix-ui-qa-/) });
	for (const call of calls.slice(2)) expect(call).toMatchObject({ tabId: 23, instance });
	expect(calls[calls.length - 1]?.command).toBe("close");
});

test("refuses to act on a redirected page and still closes the owned tab", async () => {
	const { context, calls } = mockRun([{ action: "click", locator: { css: "button" } }], (request) =>
		request.command === "page" ? { code: "ok", value: "outside-origin" } : undefined);
	expect(await runBrowserBackend(context)).toMatchObject({ status: "BLOCKED", missingCapabilities: ["approvedPage"] });
	expect(calls.map(({ command }) => command)).toEqual(["probe", "open", "navigate", "page", "close"]);
	expect(runInNewContext(pageSource(origin, { action: "click" }), { location: { origin: "https://other.test" } })).toBe("outside-origin");
});

test("failure during opening can close only the matching blank marker", async () => {
	const { context, calls } = mockRun([assertURL], (request) => request.command === "open" ? { code: "timeout" } : undefined);
	expect(await runBrowserBackend(context)).toMatchObject({ status: "FAILED", timedOut: true });
	expect(calls.map(({ command }) => command)).toEqual(["probe", "open", "close"]);
	expect(calls[calls.length - 1]).toMatchObject({ instance, marker: calls[1].marker, tabId: undefined });
});

test("cleanup failure does not report success", async () => {
	const { context } = mockRun([assertURL], (request) => request.command === "close" ? { code: "automation-permission" } : undefined);
	expect(await runBrowserBackend(context)).toMatchObject({ status: "BLOCKED", reason: "Chrome Control could not close its QA tab" });
});

test("does not repeat an interaction whose result was lost", async () => {
	const { context, calls } = mockRun([{ action: "click", locator: { testId: "save" } }], (request) =>
		request.interaction ? { code: "ok", value: "unconfirmed-interaction" } : undefined);
	expect(await runBrowserBackend(context)).toMatchObject({ status: "FAILED", reason: expect.stringContaining("was not retried") });
	expect(calls.filter((request) => request.interaction)).toHaveLength(1);
	expect(calls[calls.length - 1]).toMatchObject({ command: "close", tabId: 23 });
});

test("page programs use fixed results and report a non-matching assertion", () => {
	const location = { origin, href: target.url };
	const result = runInNewContext(pageSource(origin, { action: "assertURL", equals: `${origin}/other` }), {
		location, document: { readyState: "complete" },
	});
	expect(result).toBe("mismatch");
});

function chromeApp(pid: number, activationPolicy: number, started = instance.started) {
	return { processIdentifier: pid, activationPolicy, launchDate: { timeIntervalSince1970: started } };
}

function withChromeApps(apps: ReturnType<typeof chromeApp>[], application: (pid: number) => object) {
	const run = runInNewContext(`${jxa}\nrun;`, {
		ObjC: { import() {}, bindFunction() {} },
		$: {
			NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: String(apps.length), objectAtIndex: (index: number) => apps[index] }) },
			CGPreflightScreenCaptureAccess: () => true,
		},
		Application: application,
	}) as (argv: string[]) => string;
	return (request: Request) => JSON.parse(run([JSON.stringify(request)]));
}

test("probe ignores same-bundle background processes and targets the regular Chrome by PID", () => {
	const targeted: number[] = [];
	const apps = [chromeApp(999, 2), chromeApp(instance.pid, 0)];
	const invoke = withChromeApps(apps, (pid) => {
		targeted.push(pid);
		return { windows: { id: () => [1] } };
	});
	expect(invoke({ command: "probe" })).toEqual({ code: "ok", instance, screenshot: true });
	apps.push(chromeApp(888, 0));
	expect(invoke({ command: "probe" })).toEqual({ code: "chrome-instance-ambiguous" });
	apps.splice(1);
	expect(invoke({ command: "probe" })).toEqual({ code: "chrome-not-running" });
	expect(targeted).toEqual([instance.pid]);
});

test("a replaced Chrome process is refused before reading any tabs", () => {
	const apps = [chromeApp(instance.pid, 0)];
	const invoke = withChromeApps(apps, () => {
		apps[0] = chromeApp(instance.pid, 0, instance.started + 1);
		return { get windows() { throw new Error("must not read windows in a replaced instance"); } };
	});
	expect(invoke({ command: "close", instance, tabId: 23 })).toEqual({ code: "chrome-not-running" });
});

test("JXA ownership recovery only closes the blank marker in the pinned Chrome instance", () => {
	const closed: number[] = [];
	const marker = "about:blank#pix-ui-qa-test";
	const tabs = new Map([
		[22, { url: () => target.url, close: () => closed.push(22) }],
		[23, { url: () => marker, close: () => closed.push(23) }],
	]);
	const window = { tabs: { id: () => [...tabs.keys()], byId: (id: string) => tabs.get(Number(id)) } };
	const invoke = withChromeApps([chromeApp(999, 0), chromeApp(instance.pid, 0)], (pid) => {
		expect(pid).toBe(instance.pid);
		return { windows: { id: () => [1], byId: () => window } };
	});
	expect(invoke({ command: "close", instance: { ...instance, started: 399 }, tabId: 23, marker })).toEqual({ code: "chrome-not-running" });
	expect(invoke({ command: "navigate", instance, tabId: 22, marker, url: target.url })).toEqual({ code: "no-tab" });
	expect(invoke({ command: "close", instance, marker })).toEqual({ code: "ok" });
	expect(closed).toEqual([23]);
});

test("JXA capture requires a unique owned window before and after recording", () => {
	const ownedWindow = {
		kCGWindowOwnerPID: instance.pid, kCGWindowLayer: 0, kCGWindowBounds: { X: 0, Y: 25, Width: 900, Height: 600 },
		kCGWindowIsOnscreen: true, kCGWindowName: "QA", kCGWindowNumber: 40,
	};
	const offscreenTwin = { ...ownedWindow, kCGWindowIsOnscreen: false, kCGWindowNumber: 41, kCGWindowName: "Private" };
	const samples = [
		{ before: [ownedWindow, offscreenTwin], after: [], calls: 0, code: "window-unavailable" },
		{ before: [{ ...ownedWindow, kCGWindowName: "Private" }], after: [], calls: 0, code: "window-unavailable" },
		{ before: [ownedWindow], after: [offscreenTwin], calls: 1, code: "window-unavailable" },
		{ before: [ownedWindow], after: [ownedWindow], calls: 1, code: "ok" },
	];
	for (const sample of samples) {
		let captures = 0;
		const api = Object.assign((args: unknown) => args, {
			CGPreflightScreenCaptureAccess: () => true,
			CGWindowListCopyWindowInfo: (options: number) => {
				expect(options).toBe(0);
				return captures ? sample.after : sample.before;
			},
			NSTask: { launchedTaskWithLaunchPathArguments: (_: string, args: string[]) => {
				expect(args).toContain("-l40");
				captures++;
				return { waitUntilExit: true, terminationStatus: 0 };
			} },
		});
		const capture = runInNewContext(`${jxa}\ncapture;`, {
			ObjC: { import() {}, bindFunction() {}, deepUnwrap: (value: unknown) => value, castRefToObject: (value: unknown) => value },
			$: api,
		});
		const win = { minimized: () => false, bounds: () => ({ x: 0, y: 25, width: 900, height: 600 }), name: () => "QA", activeTab: { id: () => 23 } };
		expect(capture({ win, id: 23 }, instance.pid, "window.png", () => true)).toEqual({ code: sample.code });
		expect(captures).toBe(sample.calls);
	}
});
