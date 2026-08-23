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

function run(project: string, args: string[], agentDir?: string) {
	const env = { ...process.env };
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
    return {
      async newContext(options = {}) {
        fs.appendFileSync(path.join(process.cwd(), "context-options"), JSON.stringify({ recordVideo: Boolean(options.recordVideo) }) + "\\n");
        const videoPath = path.join(options.recordVideo?.dir || process.cwd(), "generated.webm");
        return {
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
            return {
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
              locator(selector) { return {
                async fill() { fs.appendFileSync(path.join(process.cwd(), "page-actions"), "fill:" + selector + "\\n"); },
                async click() { fs.appendFileSync(path.join(process.cwd(), "page-actions"), "click:" + selector + "\\n"); },
                async waitFor() {},
              }; },
              async screenshot({ path: screenshotPath }) { fs.writeFileSync(screenshotPath, "screenshot"); },
              isClosed() { return false; },
              video() { return { async path() { return videoPath; } }; },
            };
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
