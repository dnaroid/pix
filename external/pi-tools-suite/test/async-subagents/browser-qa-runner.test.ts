import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "../../src/async-subagents/private-skills/browser-qa/vendor/fflate.mjs";

const runner = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../src/async-subagents/private-skills/browser-qa/scripts/browser-qa-runner.mjs",
);
const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempProject(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-qa-runner-"));
	tempDirs.push(directory);
	return directory;
}

function writeFile(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
}

function writeAuth(project: string, profiles: Record<string, unknown>): void {
	const file = path.join(project, ".pi", "qa_auth.jsonc");
	writeFile(file, JSON.stringify({ profiles }, null, 2));
	fs.chmodSync(file, 0o600);
}

function createBrowserQaAgent(project: string, id = "qa-agent"): string {
	const agentDir = path.join(project, ".pi", "subagents", "test-run", id);
	const workspace = path.join(agentDir, "browser-qa");
	const flows = path.join(workspace, "flows");
	fs.mkdirSync(flows, { recursive: true, mode: 0o700 });
	writeFile(path.join(agentDir, "prompt.md"), "browser QA test\n");
	writeFile(path.join(agentDir, "project_cwd"), project);
	writeFile(path.join(agentDir, "subagent_type"), "browser-qa");
	if (process.platform !== "win32") {
		fs.chmodSync(workspace, 0o700);
		fs.chmodSync(flows, 0o700);
	}
	return fs.realpathSync(agentDir);
}

function writeAgentFlow(agentDir: string, content: string, name = "flow.jsonc"): string {
	const file = path.join(agentDir, "browser-qa", "flows", name);
	writeFile(file, content);
	return file;
}

function run(project: string, args: string[], agentDir?: string, extraEnv: Record<string, string> = {}) {
	const env = { ...process.env, ...extraEnv };
	if (agentDir) env.PI_SUBAGENT_AGENT_DIR = agentDir;
	else delete env.PI_SUBAGENT_AGENT_DIR;
	const result = spawnSync("node", [runner, ...args], { cwd: project, encoding: "utf8", env });
	return {
		code: result.status,
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
		json: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : undefined,
	};
}

function profile(secret: string, overrides: Record<string, unknown> = {}) {
	return {
		description: "Staging administrator",
		traits: ["role:admin", "plan:paid"],
		baseUrl: "https://staging.example.test",
		allowedOrigins: ["https://staging.example.test"],
		auth: {
			type: "cookie",
			cookies: [{ name: "session", value: secret, domain: "staging.example.test", path: "/" }],
		},
		...overrides,
	};
}

function installFakePlaywright(project: string): void {
	const fakeTrace = Buffer.from(zipSync({
		"trace.trace": strToU8('{"type":"action","value":"top-secret-cookie"}\n', false),
		"trace.network": strToU8('{"headers":{"cookie":"session=top-secret-cookie"}}\n', false),
	}, {})).toString("base64");
	writeFile(path.join(project, "node_modules", "playwright", "package.json"), JSON.stringify({ name: "playwright", main: "index.cjs" }));
	writeFile(path.join(project, "node_modules", "playwright", "index.cjs"), `
const fs = require("node:fs");
const path = require("node:path");

exports.chromium = {
  async launch() {
    if (process.env.BROWSER_QA_TEST_HANG_STAGE === "browser_launch") {
      if (process.env.BROWSER_QA_TEST_CHILD_PID_FILE) {
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        fs.writeFileSync(process.env.BROWSER_QA_TEST_CHILD_PID_FILE, String(child.pid));
      }
      return new Promise(() => {});
    }
    return {
      async newContext(options = {}) {
        fs.appendFileSync(path.join(process.cwd(), "context-options"), JSON.stringify({ recordVideo: Boolean(options.recordVideo) }) + "\\n");
        fs.appendFileSync(path.join(process.cwd(), "viewport-options"), JSON.stringify({
          viewport: options.viewport,
          videoSize: options.recordVideo?.size,
          environment: { locale: options.locale, timezoneId: options.timezoneId, colorScheme: options.colorScheme, reducedMotion: options.reducedMotion },
        }) + "\\n");
        const videoPath = path.join(options.recordVideo?.dir || process.cwd(), "generated.webm");
        const contextListeners = new Map();
        const onContext = (event, listener) => contextListeners.set(event, [...(contextListeners.get(event) || []), listener]);
        const offContext = (event, listener) => contextListeners.set(event, (contextListeners.get(event) || []).filter((entry) => entry !== listener));
        const emitContext = (event, value) => { for (const listener of [...(contextListeners.get(event) || [])]) listener(value); };
        return {
          on: onContext,
          off: offContext,
          async route(_pattern, handler) {
            const request = (url) => ({ url() { return url; }, headers() { return {}; } });
            await handler({
              request() { return request("https://evil.example/steal"); },
              async abort() { fs.writeFileSync(path.join(process.cwd(), "http-route-blocked"), "yes"); },
              async continue() { throw new Error("off-origin request was not blocked"); },
            });
            await handler({
              request() { return request("https://staging.example.test/api"); },
              async abort() { throw new Error("allowed-origin request was blocked"); },
              async continue({ headers } = {}) { fs.writeFileSync(path.join(process.cwd(), "allowed-route-headers"), JSON.stringify(headers || {})); },
            });
          },
          async routeWebSocket(_pattern, handler) {
            await handler({
              url() { return "wss://evil.example/socket"; },
              async close() { fs.writeFileSync(path.join(process.cwd(), "ws-route-blocked"), "yes"); },
              connectToServer() { throw new Error("off-origin WebSocket was not blocked"); },
            });
            await handler({
              url() { return "wss://staging.example.test/socket"; },
              async close() { throw new Error("allowed-origin WebSocket was blocked"); },
              connectToServer() { fs.writeFileSync(path.join(process.cwd(), "ws-route-allowed"), "yes"); },
            });
          },
          async addCookies() {},
          async addInitScript() {},
          async storageState(options = {}) {
            const state = { cookies: [{ name: "session", value: "top-secret-cookie", domain: "staging.example.test", path: "/" }], origins: [] };
            if (options.path) fs.writeFileSync(options.path, JSON.stringify(state));
            return state;
          },
          tracing: {
            async start() {},
            async stop({ path: tracePath }) { fs.writeFileSync(tracePath, Buffer.from("${fakeTrace}", "base64")); },
          },
          async newPage() {
            fs.appendFileSync(path.join(process.cwd(), "page-actions"), "page\\n");
            fs.mkdirSync(path.dirname(videoPath), { recursive: true });
            fs.writeFileSync(videoPath, "video");
            let currentUrl = "about:blank";
            let hoveredElement;
            const elements = new Map();
            const listeners = new Map();
            const on = (event, listener) => listeners.set(event, [...(listeners.get(event) || []), listener]);
            const off = (event, listener) => listeners.set(event, (listeners.get(event) || []).filter((entry) => entry !== listener));
            const emit = (event, value) => {
              fs.appendFileSync(path.join(process.cwd(), "page-actions"), "emit:" + event + "\\n");
              for (const listener of [...(listeners.get(event) || [])]) listener(value);
            };
            const assertionPolls = new Map();
            const nextAssertionPoll = (key) => {
              const count = (assertionPolls.get(key) || 0) + 1;
              assertionPolls.set(key, count);
              return count;
            };
            const elementFor = (selector) => {
              if (!elements.has(selector)) elements.set(selector, {
                scrollLeft: 0,
                scrollTop: 0,
                scrollWidth: 600,
                scrollHeight: 1000,
                clientWidth: 300,
                clientHeight: 200,
                scrollTo(x, y) { this.scrollLeft = Math.max(0, Math.min(x, this.scrollWidth - this.clientWidth)); this.scrollTop = Math.max(0, Math.min(y, this.scrollHeight - this.clientHeight)); },
                scrollBy(x, y) { this.scrollTo(this.scrollLeft + x, this.scrollTop + y); },
                getBoundingClientRect() { return { x: 10, y: 20, width: this.clientWidth, height: this.clientHeight }; },
              });
              return elements.get(selector);
            };
            const page = {
              on,
              off,
              waitForEvent(event, options = {}) {
                return new Promise((resolve, reject) => {
                  const handler = (value) => { off(event, handler); clearTimeout(timer); resolve(value); };
                  const timer = setTimeout(() => { off(event, handler); reject(new Error("event timeout")); }, options.timeout || 1000);
                  on(event, handler);
                });
              },
              setDefaultTimeout(value) { fs.appendFileSync(path.join(process.cwd(), "default-timeouts"), String(value) + "\\n"); },
              setDefaultNavigationTimeout(value) { fs.appendFileSync(path.join(process.cwd(), "navigation-timeouts"), String(value) + "\\n"); },
              async goto(url, options = {}) {
                currentUrl = url;
                fs.appendFileSync(path.join(process.cwd(), "page-actions"), "goto:" + url + "\\n");
                if (options.timeout) fs.appendFileSync(path.join(process.cwd(), "goto-timeouts"), String(options.timeout) + "\\n");
              },
              async reload() {},
              async waitForTimeout() {},
              async waitForURL() {},
              url() { return currentUrl; },
              async content() { return "<html><body><h1>Settings</h1></body></html>"; },
              locator(selector) {
                const element = elementFor(selector);
                const locator = {
                  selector,
                  async fill() { fs.appendFileSync(path.join(process.cwd(), "page-actions"), "fill:" + selector + "\\n"); },
                  async click() {
                    fs.appendFileSync(path.join(process.cwd(), "page-actions"), "click:" + selector + "\\n");
                    if (selector === ".atomic") {
                      const evilRequest = { url() { return "https://evil.example/api/atomic"; }, method() { return "POST"; } };
                      const matchingRequest = { url() { return "https://staging.example.test/api/atomic?secret=hidden"; }, method() { return "POST"; } };
                      emit("request", evilRequest);
                      emit("response", { request() { return evilRequest; }, status() { return 204; } });
                      emit("request", matchingRequest);
                      emit("response", { request() { return matchingRequest; }, status() { return 204; } });
                      emit("dialog", {
                        type() { return "confirm"; },
                        message() { return "Proceed safely?"; },
                        async accept() { fs.writeFileSync(path.join(process.cwd(), "dialog-result"), "accepted"); },
                        async dismiss() { fs.writeFileSync(path.join(process.cwd(), "dialog-result"), "dismissed"); },
                      });
                    }
                    if (selector === ".bad-dialog") emit("dialog", {
                      type() { return "confirm"; },
                      message() { return "secret-dialog-value"; },
                      async accept() { fs.writeFileSync(path.join(process.cwd(), "dialog-result"), "accepted"); },
                      async dismiss() { fs.writeFileSync(path.join(process.cwd(), "dialog-result"), "dismissed"); },
                    });
                    if (selector === ".preexisting-response") {
                      const request = { url() { return "https://staging.example.test/api/atomic"; }, method() { return "POST"; } };
                      emit("response", { request() { return request; }, status() { return 204; } });
                    }
                    if (selector === ".unexpected-popup") {
                      const unexpectedVideoPath = path.join(options.recordVideo?.dir || process.cwd(), "unexpected.webm");
                      fs.writeFileSync(unexpectedVideoPath, "unexpected-video");
                      emitContext("page", {
                        video() { return { async path() { return unexpectedVideoPath; } }; },
                        async close() { fs.writeFileSync(path.join(process.cwd(), "unexpected-popup-closed"), "yes"); },
                      });
                    }
                    if (selector === ".download" || selector === ".secret-download") emit("download", {
                      url() { return "https://staging.example.test/export"; },
                      suggestedFilename() { return "report.csv"; },
                      async saveAs(file) { fs.writeFileSync(file, selector === ".secret-download" ? "top-secret-cookie" : "a,b\\n1,2\\n"); },
                      async cancel() {},
                    });
                  },
                  async hover() { hoveredElement = element; fs.appendFileSync(path.join(process.cwd(), "page-actions"), "hover:" + selector + "\\n"); },
                  async evaluate(callback, argument) { return callback(element, argument); },
                  async dragTo(destination, options) { fs.appendFileSync(path.join(process.cwd(), "page-actions"), "drag:" + selector + "->" + destination.selector + ":" + JSON.stringify(options) + "\\n"); },
                  async setInputFiles(files) { fs.appendFileSync(path.join(process.cwd(), "page-actions"), "upload:" + selector + ":" + files.map((file) => file.name + "=" + file.buffer.toString("utf8")).join(",") + "\\n"); },
                  async textContent() { return nextAssertionPoll(selector + ":text") > 1 ? "ready" : "pending"; },
                  async getAttribute(name) { return nextAssertionPoll(selector + ":" + name) > 1 ? "ready" : "pending"; },
                  async waitFor() {},
                };
                return locator;
              },
              mouse: {
                async wheel(deltaX, deltaY) {
                  fs.appendFileSync(path.join(process.cwd(), "page-actions"), "wheel:" + deltaX + "," + deltaY + "\\n");
                  if (hoveredElement) hoveredElement.scrollBy(deltaX, deltaY);
                },
              },
              async screenshot({ path: screenshotPath }) { fs.writeFileSync(screenshotPath, "screenshot"); },
              isClosed() { return false; },
              video() { return { async path() { return videoPath; } }; },
            };
            return page;
          },
          async close() {},
        };
      },
      async close() {},
    };
  },
};
`);
}

describe("private browser QA runner", () => {
	test("bounds a hung browser stage, kills its detached child, and leaves sanitized progress", async () => {
		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		installFakePlaywright(project);
		const flow = writeAgentFlow(agentDir, JSON.stringify({ steps: [{ action: "goto", path: "/public" }] }));
		const childPidFile = path.join(project, "hung-browser-child.pid");

		const result = run(project, [
			"run",
			"--base-url", "https://staging.example.test",
			"--flow", flow,
			"--run-id", "hung-launch",
			"--runner-timeout-ms", "100",
		], agentDir, {
			BROWSER_QA_TEST_HANG_STAGE: "browser_launch",
			BROWSER_QA_TEST_CHILD_PID_FILE: childPidFile,
		});

		expect(result).toMatchObject({
			code: 124,
			stderr: "",
			json: {
				status: "QA_RUN_FAILED",
				profile: "public",
				timedOut: true,
				lastStage: "browser_launch",
			},
		});
		const progress = fs.readFileSync(path.join(agentDir, "browser-qa", "progress.jsonl"), "utf8");
		expect(progress).toContain('"stage":"browser_launch_started"');
		expect(progress).toContain('"stage":"browser_launch_timed_out"');
		expect(progress).toContain('"stage":"runner_finished"');
		expect(progress).not.toContain(flow);
		if (process.platform !== "win32") {
			const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
			const deadline = Date.now() + 1000;
			while (Date.now() < deadline) {
				try {
					process.kill(childPid, 0);
					await new Promise((resolve) => setTimeout(resolve, 10));
				} catch {
					return;
				}
			}
			throw new Error(`detached browser child ${childPid} survived runner timeout`);
		}
	});

	test("terminates hung synchronous trace sanitization in a worker", () => {
		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		installFakePlaywright(project);
		const flow = writeAgentFlow(agentDir, JSON.stringify({ steps: [{ action: "goto", path: "/public" }] }));
		const startedAt = Date.now();

		const result = run(project, [
			"run",
			"--base-url", "https://staging.example.test",
			"--flow", flow,
			"--run-id", "hung-trace-sanitize",
			"--runner-timeout-ms", "10000",
		], agentDir, { BROWSER_QA_TEST_HANG_STAGE: "trace_sanitize" });

		expect(Date.now() - startedAt).toBeLessThan(7000);
		expect(result).toMatchObject({ code: 1, stderr: "", json: { status: "QA_RUN_FAILED", profile: "public" } });
		const progress = fs.readFileSync(path.join(agentDir, "browser-qa", "progress.jsonl"), "utf8");
		expect(progress).toContain('"stage":"trace_sanitize_started"');
		expect(progress).toContain('"stage":"trace_sanitize_timed_out"');
		expect(progress).toContain('"stage":"runner_finished"');
	}, 8000);

	test("lists auth profiles without exposing credentials or origins", () => {
		const project = tempProject();
		const secret = "top-secret-cookie";
		writeAuth(project, { admin: profile(secret), subscriber: profile("other-secret") });

		const listed = run(project, ["profiles"]);
		expect(listed).toMatchObject({ code: 0, stderr: "", json: { status: "QA_PROFILES", authConfigPresent: true } });
		expect(listed.json.profiles).toEqual([
			{ id: "admin", description: "Staging administrator", traits: ["role:admin", "plan:paid"] },
			{ id: "subscriber", description: "Staging administrator", traits: ["role:admin", "plan:paid"] },
		]);
		expect(listed.stdout).not.toContain(secret);
		expect(listed.stdout).not.toContain("staging.example.test");
	});

	test("runs public QA without auth config or profile", () => {
		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		installFakePlaywright(project);
		const flow = writeAgentFlow(agentDir, JSON.stringify({ steps: [
			{ action: "goto", path: "/public" },
			{ action: "assertURL", equals: "https://staging.example.test/public" },
		] }));

		const listed = run(project, ["profiles"]);
		expect(listed).toMatchObject({
			code: 0,
			json: { status: "QA_PROFILES", authConfigPresent: false, profiles: [] },
		});
		expect(fs.existsSync(path.join(project, ".pi", "qa_auth.jsonc"))).toBe(false);

		const result = run(project, ["run", "--base-url", "https://staging.example.test", "--flow", flow, "--run-id", "public"], agentDir);
		expect(result).toMatchObject({ code: 0, json: { status: "QA_PASSED", profile: "public" } });
		expect(fs.existsSync(path.join(project, ".pi", "qa_auth.jsonc"))).toBe(false);

		const missingBaseUrl = run(project, ["run", "--flow", flow], agentDir);
		expect(missingBaseUrl).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED", profile: "public" } });
		expect(missingBaseUrl.json.reason).toContain("--base-url is required");
	});

	test("applies viewport and supports safe scrolling, metrics, and retrying assertions", () => {
		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		installFakePlaywright(project);
		const flow = writeAgentFlow(agentDir, JSON.stringify({
			viewport: { width: 844, height: 847 },
			steps: [
				{ action: "goto", path: "/public" },
				{ action: "evaluate", operation: "scrollTo", locator: { css: ".decision-detail" }, y: 0 },
				{ action: "wheel", locator: { css: ".decision-detail" }, deltaY: 120 },
				{ action: "assertDOMMetric", locator: { css: ".decision-detail" }, metric: "scrollTop", greaterThan: 0 },
				{ action: "evaluate", operation: "metrics", locator: { css: ".decision-detail" }, name: "detail-after-wheel" },
				{ action: "assertText", locator: { css: ".delayed-result" }, equals: "ready" },
				{ action: "assertAttribute", locator: { css: ".delayed-result" }, attribute: "data-state", equals: "ready" },
			],
		}));

		const result = run(project, ["run", "--base-url", "https://staging.example.test", "--flow", flow, "--run-id", "scroll"], agentDir);

		expect(result).toMatchObject({
			code: 0,
			json: {
				status: "QA_PASSED",
				viewport: { width: 844, height: 847 },
				observations: [{ name: "detail-after-wheel", step: 5, value: { scrollTop: 120, scrollHeight: 1000, clientHeight: 200 } }],
			},
		});
		expect(JSON.parse(fs.readFileSync(path.join(project, "viewport-options"), "utf8").trim())).toEqual({
			viewport: { width: 844, height: 847 },
			videoSize: { width: 844, height: 847 },
			environment: { locale: "en-US", timezoneId: "UTC", colorScheme: "light", reducedMotion: "reduce" },
		});
		expect(fs.readFileSync(path.join(project, "page-actions"), "utf8")).toContain("wheel:0,120");
	});

	test("supports deterministic environment, atomic expectations, drag/drop, memory uploads, and bounded downloads", () => {
		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		installFakePlaywright(project);
		const flow = writeAgentFlow(agentDir, JSON.stringify({
			environment: { locale: "en-GB", timezoneId: "Europe/London", colorScheme: "dark", reducedMotion: "no-preference" },
			steps: [
				{ action: "goto", path: "/public" },
				{
					action: "click",
					locator: { css: ".atomic" },
					expectResponse: { path: "/api/atomic", method: "POST", status: 204 },
					expectDialog: { type: "confirm", message: { equals: "Proceed safely?" }, accept: true },
				},
				{
					action: "dragTo",
					locator: { css: ".source" },
					dropTarget: { css: ".destination" },
					sourcePosition: { x: 10, y: 20 },
					dropPosition: { x: 30, y: 40 },
				},
				{
					action: "uploadFiles",
					locator: { css: "input[type=file]" },
					files: [{ name: "sample.csv", mimeType: "text/csv", base64: Buffer.from("a,b\n1,2\n").toString("base64") }],
				},
				{
					action: "download",
					locator: { css: ".download" },
					filename: { equals: "report.csv" },
					maxBytes: 1024,
					retain: true,
					name: "report",
				},
			],
		}));

		const result = run(project, ["run", "--base-url", "https://staging.example.test", "--flow", flow, "--run-id", "capabilities"], agentDir);

		expect(result).toMatchObject({
			code: 0,
			json: {
				status: "QA_PASSED",
				environment: { locale: "en-GB", timezoneId: "Europe/London", colorScheme: "dark", reducedMotion: "no-preference" },
				artifacts: { downloads: [{ path: expect.stringContaining("download-report.bin"), uri: expect.stringContaining("download-report.bin") }] },
			},
		});
		expect(fs.readFileSync(path.join(project, "dialog-result"), "utf8")).toBe("accepted");
		const actions = fs.readFileSync(path.join(project, "page-actions"), "utf8");
		expect(actions).toContain('drag:.source->.destination:{"sourcePosition":{"x":10,"y":20},"targetPosition":{"x":30,"y":40}}');
		expect(actions).toContain("upload:input[type=file]:sample.csv=a,b\n1,2");
	});

	test("rejects unsafe capability inputs without exposing observed dialog content", () => {
		const cases = [
			{
				name: "response",
				flow: { steps: [{ action: "click", locator: { css: ".atomic" }, expectResponse: { path: "/api/items?token=secret", method: "POST", status: 200 } }] },
				reason: "exact path, method, and status",
			},
			{
				name: "upload",
				flow: { steps: [{ action: "uploadFiles", locator: { css: "input" }, files: [{ name: "secret", mimeType: "text/plain", path: ".pi/qa_auth.jsonc" }] }] },
				reason: "canonical base64",
			},
			{
				name: "environment",
				flow: { environment: { timezoneId: "Not/A_Timezone" }, steps: [{ action: "goto", path: "/" }] },
				reason: "timezoneId is invalid",
			},
			{
				name: "download",
				flow: { steps: [{ action: "download", locator: { css: ".download" }, filename: { equals: "report.csv" }, maxBytes: 2, retain: true, name: "too-large" }] },
				reason: "exceeded maxBytes",
			},
		];
		for (const item of cases) {
			const project = tempProject();
			const agentDir = createBrowserQaAgent(project);
			installFakePlaywright(project);
			const flow = writeAgentFlow(agentDir, JSON.stringify(item.flow));
			const result = run(project, ["run", "--base-url", "https://staging.example.test", "--flow", flow, "--run-id", item.name], agentDir);
			expect(result).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED" } });
			expect(result.json.reason).toContain(item.reason);
		}

		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		installFakePlaywright(project);
		const flow = writeAgentFlow(agentDir, JSON.stringify({ steps: [{
			action: "click",
			locator: { css: ".bad-dialog" },
			expectDialog: { type: "confirm", message: { equals: "different" }, accept: true },
		}] }));
		const mismatch = run(project, ["run", "--base-url", "https://staging.example.test", "--flow", flow, "--run-id", "dialog-mismatch"], agentDir);
		expect(mismatch).toMatchObject({ code: 1, json: { reason: expect.stringContaining("native dialog did not match expectation") } });
		expect(fs.readFileSync(path.join(project, "dialog-result"), "utf8")).toBe("dismissed");
		expect(mismatch.stdout).not.toContain("secret-dialog-value");

		const responseProject = tempProject();
		const responseAgentDir = createBrowserQaAgent(responseProject);
		installFakePlaywright(responseProject);
		const responseFlow = writeAgentFlow(responseAgentDir, JSON.stringify({ timeoutMs: 100, steps: [{
			action: "click",
			locator: { css: ".preexisting-response" },
			expectResponse: { path: "/api/atomic", method: "POST", status: 204 },
		}] }));
		const preexisting = run(responseProject, ["run", "--base-url", "https://staging.example.test", "--flow", responseFlow, "--run-id", "preexisting-response"], responseAgentDir);
		expect(preexisting).toMatchObject({ code: 1, json: { reason: expect.stringContaining("expected response was not observed") } });

		const popupProject = tempProject();
		const popupAgentDir = createBrowserQaAgent(popupProject);
		installFakePlaywright(popupProject);
		const popupFlow = writeAgentFlow(popupAgentDir, JSON.stringify({ steps: [{ action: "click", locator: { css: ".unexpected-popup" } }] }));
		const unexpectedPopup = run(popupProject, ["run", "--base-url", "https://staging.example.test", "--flow", popupFlow, "--run-id", "unexpected-popup"], popupAgentDir);
		expect(unexpectedPopup).toMatchObject({ code: 1, json: { reason: expect.stringContaining("use openPopup") } });
		expect(fs.readFileSync(path.join(popupProject, "unexpected-popup-closed"), "utf8")).toBe("yes");
		expect(unexpectedPopup.json.evidence).not.toContain(expect.stringContaining("discarded-popup"));
	});

	test("discards retained downloads that contain configured authentication", () => {
		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		writeAuth(project, { admin: profile("top-secret-cookie") });
		installFakePlaywright(project);
		const flow = writeAgentFlow(agentDir, JSON.stringify({ steps: [{
			action: "download",
			locator: { css: ".secret-download" },
			filename: { equals: "report.csv" },
			maxBytes: 1024,
			retain: true,
			name: "secret",
		}] }));

		const result = run(project, ["run", "--profile", "admin", "--flow", flow, "--run-id", "secret-download"], agentDir);

		expect(result).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED", profile: "admin", evidence: [] } });
		expect(result.json.reason).toContain("retained download");
		expect(result.stdout).not.toContain("top-secret-cookie");
	});

	test("rejects unsafe evaluate scripts and out-of-range viewports", () => {
		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		installFakePlaywright(project);
		const scriptFlow = writeAgentFlow(agentDir, JSON.stringify({ steps: [
			{ action: "evaluate", expression: "window.localStorage" },
		] }), "script.jsonc");
		const scriptResult = run(project, ["run", "--base-url", "https://staging.example.test", "--flow", scriptFlow, "--run-id", "script"], agentDir);
		expect(scriptResult).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED" } });
		expect(scriptResult.json.reason).toContain("executable JavaScript is not allowed");

		const viewportFlow = writeAgentFlow(agentDir, JSON.stringify({
			viewport: { width: 200, height: 100 },
			steps: [{ action: "goto", path: "/" }],
		}), "viewport.jsonc");
		const viewportResult = run(project, ["run", "--base-url", "https://staging.example.test", "--flow", viewportFlow, "--run-id", "viewport"], agentDir);
		expect(viewportResult).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED" } });
		expect(viewportResult.json.reason).toContain("320x240");

		const attributeFlow = writeAgentFlow(agentDir, JSON.stringify({ steps: [
			{ action: "assertAttribute", locator: { css: "main" }, attribute: "bad attribute", equals: "value" },
		] }), "attribute.jsonc");
		const attributeResult = run(project, ["run", "--base-url", "https://staging.example.test", "--flow", attributeFlow, "--run-id", "attribute"], agentDir);
		expect(attributeResult).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED" } });
		expect(attributeResult.json.reason).toContain("valid attribute name");
	});

	test("rejects invalid configuration for every supported auth mode", () => {
		const invalidAuth = [
			{ type: "cookie", cookies: [] },
			{ type: "localStorage", entries: {} },
			{ type: "sessionStorage", origin: "https://evil.example", entries: { token: "secret" } },
			{ type: "bearer", token: "" },
			{ type: "form", loginUrl: "https://staging.example.test/login", fields: [], submitSelector: "button", success: { selector: "main" } },
			{ type: "storageState", path: ".pi/missing-state.json" },
		];
		for (const [index, auth] of invalidAuth.entries()) {
			const project = tempProject();
			const agentDir = createBrowserQaAgent(project);
			writeAuth(project, { admin: profile("unused-secret", { auth }) });
			const flow = writeAgentFlow(agentDir, '{"steps":[{"action":"goto","path":"/"}]}\n');
			const result = run(project, ["run", "--profile", "admin", "--flow", flow, "--run-id", `invalid-${index}`], agentDir);
			expect(result).toMatchObject({ code: 42, json: { status: "QA_AUTH_UPDATE_REQUIRED", profile: "admin" } });
		}
	});

	test("requires the launcher-owned agent directory and rejects flows outside its workspace", () => {
		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		writeAuth(project, { admin: profile("top-secret-cookie") });
		installFakePlaywright(project);
		const localFlow = writeAgentFlow(agentDir, '{"steps":[{"action":"goto","path":"/"}]}\n');
		const missingAgentDir = run(project, ["run", "--profile", "admin", "--flow", localFlow]);
		expect(missingAgentDir).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED", profile: "admin" } });
		expect(missingAgentDir.json.reason).toContain("PI_SUBAGENT_AGENT_DIR");

		const outsideFlow = path.join(project, "outside-flow.jsonc");
		writeFile(outsideFlow, '{"steps":[{"action":"goto","path":"/"}]}\n');
		const outside = run(project, ["run", "--profile", "admin", "--flow", outsideFlow], agentDir);
		expect(outside).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED", profile: "admin" } });
		expect(outside.json.reason).toContain("project-local");
		expect(fs.existsSync(path.join(project, ".pi", "qa-runs"))).toBe(false);
	});

	test("executes every supported auth mode through the trusted flow runner", () => {
		const authModes: Array<[string, Record<string, unknown>]> = [
			["cookie", { type: "cookie", cookies: [{ name: "session", value: "cookie-secret", domain: "staging.example.test", path: "/" }] }],
			["local", { type: "localStorage", entries: { access_token: "local-secret" } }],
			["session", { type: "sessionStorage", entries: { access_token: "session-secret" } }],
			["bearer", { type: "bearer", token: "bearer-secret" }],
			["form", {
				type: "form",
				loginUrl: "https://staging.example.test/login",
				fields: [{ selector: "#email", value: "qa@example.test" }, { selector: "#password", value: "form-secret" }],
				submitSelector: "button[type=submit]",
				success: { selector: "main" },
				timeoutMs: 120_000,
			}],
		];
		for (const [name, auth] of authModes) {
			const project = tempProject();
			const agentDir = createBrowserQaAgent(project);
			writeAuth(project, { admin: profile("unused-secret", { auth }) });
			installFakePlaywright(project);
			const flow = writeAgentFlow(agentDir, JSON.stringify({ steps: [{ action: "goto", path: "/settings" }] }));
			const result = run(project, ["run", "--profile", "admin", "--flow", flow, "--run-id", name], agentDir);
			expect(result).toMatchObject({ code: 0, json: { status: "QA_PASSED", profile: "admin" } });
			expect(fs.readFileSync(path.join(project, "http-route-blocked"), "utf8")).toBe("yes");
			expect(fs.readFileSync(path.join(project, "ws-route-blocked"), "utf8")).toBe("yes");
			expect(fs.readFileSync(path.join(project, "ws-route-allowed"), "utf8")).toBe("yes");
			if (name === "bearer") expect(fs.readFileSync(path.join(project, "allowed-route-headers"), "utf8")).toContain("bearer-secret");
			if (name === "form") {
				expect(fs.readFileSync(path.join(project, "context-options"), "utf8").trim().split("\n")).toEqual([
					JSON.stringify({ recordVideo: true }),
				]);
				expect(fs.readFileSync(path.join(project, "page-actions"), "utf8").trim().split("\n")).toEqual([
					"page",
					"goto:https://staging.example.test/login",
					"fill:#email",
					"fill:#password",
					"click:button[type=submit]",
					"goto:https://staging.example.test/settings",
				]);
				expect(fs.readFileSync(path.join(project, "default-timeouts"), "utf8").split("\n")[0]).toBe("60000");
				expect(fs.readFileSync(path.join(project, "navigation-timeouts"), "utf8").split("\n")[0]).toBe("60000");
				expect(fs.readFileSync(path.join(project, "goto-timeouts"), "utf8").trim()).toBe("60000");
			}
		}

		const storageProject = tempProject();
		const storageAgentDir = createBrowserQaAgent(storageProject);
		const stateFile = path.join(storageProject, ".pi", "imported-state.json");
		writeFile(stateFile, JSON.stringify({ cookies: [], origins: [] }));
		fs.chmodSync(stateFile, 0o600);
		writeAuth(storageProject, { admin: profile("unused-secret", { auth: { type: "storageState", path: ".pi/imported-state.json" } }) });
		installFakePlaywright(storageProject);
		const storageFlow = writeAgentFlow(storageAgentDir, JSON.stringify({ steps: [{ action: "goto", path: "/settings" }] }));
		const storageResult = run(storageProject, ["run", "--profile", "admin", "--flow", storageFlow, "--run-id", "storage"], storageAgentDir);
		expect(storageResult).toMatchObject({ code: 0, json: { status: "QA_PASSED", profile: "admin" } });
	});

	test("rejects permissive auth files, symlinked flows, and evidence collisions", () => {
		if (process.platform === "win32") return;
		const permissive = tempProject();
		writeAuth(permissive, { admin: profile("top-secret-cookie") });
		fs.chmodSync(path.join(permissive, ".pi", "qa_auth.jsonc"), 0o644);
		const modeResult = run(permissive, ["profiles"]);
		expect(modeResult).toMatchObject({ code: 42, json: { status: "QA_AUTH_UPDATE_REQUIRED" } });
		expect(modeResult.json.reason).toContain("0600");

		const symlinked = tempProject();
		const symlinkedAgentDir = createBrowserQaAgent(symlinked);
		writeAuth(symlinked, { admin: profile("top-secret-cookie") });
		installFakePlaywright(symlinked);
		const realFlow = writeAgentFlow(symlinkedAgentDir, '{"steps":[{"action":"goto","path":"/"}]}', "real-flow.jsonc");
		const symlinkedFlow = path.join(symlinkedAgentDir, "browser-qa", "flows", "flow.jsonc");
		fs.symlinkSync(realFlow, symlinkedFlow);
		const symlinkResult = run(symlinked, ["run", "--profile", "admin", "--flow", symlinkedFlow, "--run-id", "symlink"], symlinkedAgentDir);
		expect(symlinkResult).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED" } });
		expect(symlinkResult.json.reason).toContain("symbolic links");

		const collision = tempProject();
		const collisionAgentDir = createBrowserQaAgent(collision);
		writeAuth(collision, { admin: profile("top-secret-cookie") });
		installFakePlaywright(collision);
		const collisionFlow = writeAgentFlow(collisionAgentDir, '{"steps":[{"action":"goto","path":"/"}]}');
		const evidenceDir = path.join(collisionAgentDir, "browser-qa", "evidence", "proof", "admin");
		fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
		fs.chmodSync(path.join(collisionAgentDir, "browser-qa", "evidence"), 0o700);
		fs.chmodSync(path.join(collisionAgentDir, "browser-qa", "evidence", "proof"), 0o700);
		writeFile(path.join(evidenceDir, "keep"), "original");
		const collisionResult = run(collision, ["run", "--profile", "admin", "--flow", collisionFlow, "--run-id", "proof"], collisionAgentDir);
		expect(collisionResult).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED" } });
		expect(fs.readFileSync(path.join(evidenceDir, "keep"), "utf8")).toBe("original");
	});

	test("never executes a model-authored JavaScript file", () => {
		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		writeAuth(project, { admin: profile("top-secret-cookie") });
		installFakePlaywright(project);
		const flow = writeAgentFlow(agentDir, "require('node:fs').writeFileSync('executed', 'yes');\n", "flow.cjs");
		const result = run(project, ["run", "--profile", "admin", "--flow", flow, "--run-id", "code"], agentDir);
		expect(result).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED", profile: "admin" } });
		expect(fs.existsSync(path.join(project, "executed"))).toBe(false);
	});

	test("creates a private empty auth template and explicitly requests credentials", () => {
		const project = tempProject();
		const publicProfiles = run(project, ["profiles"]);
		expect(publicProfiles).toMatchObject({
			code: 0,
			json: { status: "QA_PROFILES", authConfigPresent: false, profiles: [] },
		});
		expect(fs.existsSync(path.join(project, ".pi", "qa_auth.jsonc"))).toBe(false);

		const missing = run(project, ["profiles", "--require-auth"]);
		expect(missing).toMatchObject({
			code: 42,
			json: {
				status: "QA_AUTH_UPDATE_REQUIRED",
				file: ".pi/qa_auth.jsonc",
				action: "provide_credentials",
				templateCreated: true,
			},
		});
		expect(missing.json.reason).toContain("credentials are required");
		const template = path.join(project, ".pi", "qa_auth.jsonc");
		expect(fs.readFileSync(template, "utf8")).toContain('"profiles": {');
		expect(fs.readFileSync(template, "utf8")).not.toContain("replace-me");
		if (process.platform !== "win32") expect(fs.statSync(template).mode & 0o777).toBe(0o600);

		const emptyProfiles = run(project, ["profiles"]);
		expect(emptyProfiles).toMatchObject({
			code: 0,
			json: { status: "QA_PROFILES", authConfigPresent: true, profiles: [] },
		});

		const stillEmpty = run(project, ["profiles", "--require-auth"]);
		expect(stillEmpty).toMatchObject({
			code: 42,
			json: { action: "provide_credentials", templateCreated: false },
		});
		expect(stillEmpty.json.reason).toContain("non-empty profiles object");

		if (process.platform !== "win32") {
			const symlinkProject = tempProject();
			const outside = tempProject();
			fs.symlinkSync(outside, path.join(symlinkProject, ".pi"), "dir");
			const symlinkedDirectory = run(symlinkProject, ["profiles", "--require-auth"]);
			expect(symlinkedDirectory).toMatchObject({ code: 42, json: { status: "QA_AUTH_UPDATE_REQUIRED" } });
			expect(symlinkedDirectory.json.reason).toContain("real project-local directory");
			expect(fs.existsSync(path.join(outside, "qa_auth.jsonc"))).toBe(false);
		}
	});

	test("rejects disallowed base URLs with update-required status", () => {

		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		writeAuth(project, { admin: profile("top-secret-cookie") });
		const flow = writeAgentFlow(agentDir, '{"steps":[{"action":"goto","path":"/"}]}\n');
		const rejected = run(project, ["run", "--profile", "admin", "--base-url", "https://evil.example", "--flow", flow], agentDir);
		expect(rejected).toMatchObject({ code: 42, json: { status: "QA_AUTH_UPDATE_REQUIRED", profile: "admin" } });
		expect(rejected.json.reason).toContain("allowedOrigins");
		expect(rejected.stdout).not.toContain("top-secret-cookie");
	});

	test("creates isolated screenshot, video, trace, and redacted result evidence", () => {
		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		const secret = "top-secret-cookie";
		writeAuth(project, { admin: profile(secret) });
		installFakePlaywright(project);
		const flow = writeAgentFlow(agentDir, JSON.stringify({ steps: [
			{ action: "goto", path: "/settings" },
			{ action: "assertURL", equals: "https://staging.example.test/settings" },
		] }));

		const result = run(project, ["run", "--profile", "admin", "--flow", flow, "--run-id", "proof"], agentDir);
		const relativeEvidenceDir = path.relative(fs.realpathSync(project), path.join(agentDir, "browser-qa", "evidence", "proof", "admin")).split(path.sep).join("/");
		expect(result).toMatchObject({
			code: 0,
			stderr: "",
			json: { status: "QA_PASSED", profile: "admin", evidenceDir: relativeEvidenceDir },
		});
		expect(result.json.evidence.sort()).toEqual(["final.png", "trace.zip", "video.webm"]);
		const evidenceDir = path.join(fs.realpathSync(agentDir), "browser-qa", "evidence", "proof", "admin");
		expect(result.json.artifacts).toEqual({
			downloads: [],
			screenshots: [{ path: path.join(evidenceDir, "final.png"), uri: pathToFileURL(path.join(evidenceDir, "final.png")).href }],
			videos: [{ path: path.join(evidenceDir, "video.webm"), uri: pathToFileURL(path.join(evidenceDir, "video.webm")).href }],
			traces: [{ path: path.join(evidenceDir, "trace.zip"), uri: pathToFileURL(path.join(evidenceDir, "trace.zip")).href }],
		});
		for (const name of ["final.png", "trace.zip", "video.webm", "result.json"]) {
			expect(fs.existsSync(path.join(evidenceDir, name))).toBe(true);
			expect(fs.readFileSync(path.join(evidenceDir, name), "utf8")).not.toContain(secret);
		}
		const traceEntries = unzipSync(new Uint8Array(fs.readFileSync(path.join(evidenceDir, "trace.zip"))), {});
		expect(Object.keys(traceEntries)).toEqual(["trace.trace"]);
		expect(strFromU8(traceEntries["trace.trace"], false)).toContain("[REDACTED]");
		expect(strFromU8(traceEntries["trace.trace"], false)).not.toContain(secret);
		expect(result.stdout).not.toContain(secret);
		expect(fs.readFileSync(path.join(project, "http-route-blocked"), "utf8")).toBe("yes");
		expect(fs.readFileSync(path.join(project, "ws-route-blocked"), "utf8")).toBe("yes");
		expect(fs.readFileSync(path.join(project, "ws-route-allowed"), "utf8")).toBe("yes");
		expect(fs.existsSync(path.join(project, ".pi", "qa-runs"))).toBe(false);
		const runDir = path.dirname(agentDir);
		fs.rmSync(runDir, { recursive: true, force: true });
		expect(fs.existsSync(evidenceDir)).toBe(false);
	});

	test("turns application auth rejection into a redacted update request", () => {
		const project = tempProject();
		const agentDir = createBrowserQaAgent(project);
		const secret = "top-secret-cookie";
		writeAuth(project, { admin: profile(secret) });
		installFakePlaywright(project);
		const flow = writeAgentFlow(agentDir, JSON.stringify({ steps: [
			{ action: "goto", path: "/login" },
			{ action: "authRejectedIf", urlIncludes: "/login" },
		] }));

		const result = run(project, ["run", "--profile", "admin", "--flow", flow, "--run-id", "expired"], agentDir);
		expect(result).toMatchObject({
			code: 42,
			json: { status: "QA_AUTH_UPDATE_REQUIRED", profile: "admin", file: ".pi/qa_auth.jsonc" },
		});
		expect(result.json.reason).toContain("rejected or expired");
		expect(result.json.artifacts.screenshots[0].path).toEndWith(path.join("expired", "admin", "failure.png"));
		expect(result.json.artifacts.videos[0].uri).toStartWith("file:");
		expect(result.json.artifacts.traces[0].uri).toStartWith("file:");
		expect(result.stdout).not.toContain(secret);
	});
});
