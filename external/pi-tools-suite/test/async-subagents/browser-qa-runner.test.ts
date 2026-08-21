import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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

function run(project: string, args: string[]) {
	const result = spawnSync("node", [runner, ...args], { cwd: project, encoding: "utf8" });
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
            fs.mkdirSync(path.dirname(videoPath), { recursive: true });
            fs.writeFileSync(videoPath, "video");
            let currentUrl = "about:blank";
            return {
              setDefaultTimeout() {},
              setDefaultNavigationTimeout() {},
              async goto(url) { currentUrl = url; },
              async reload() {},
              async waitForTimeout() {},
              async waitForURL() {},
              url() { return currentUrl; },
              async content() { return "<html><body><h1>Settings</h1></body></html>"; },
              locator() { return { async fill() {}, async click() {}, async waitFor() {} }; },
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
	test("lists and requests profiles without exposing credentials or origins", () => {
		const project = tempProject();
		const secret = "top-secret-cookie";
		writeAuth(project, { admin: profile(secret), subscriber: profile("other-secret") });

		const listed = run(project, ["profiles"]);
		expect(listed).toMatchObject({ code: 0, stderr: "", json: { status: "QA_PROFILES" } });
		expect(listed.json.profiles).toEqual([
			{ id: "admin", description: "Staging administrator", traits: ["role:admin", "plan:paid"] },
			{ id: "subscriber", description: "Staging administrator", traits: ["role:admin", "plan:paid"] },
		]);
		expect(listed.stdout).not.toContain(secret);
		expect(listed.stdout).not.toContain("staging.example.test");

		const required = run(project, ["run", "--flow", "flow.jsonc"]);
		expect(required).toMatchObject({ code: 43, json: { status: "QA_PROFILE_REQUIRED", file: ".pi/qa_auth.jsonc" } });
		expect(required.json.profiles).toEqual(listed.json.profiles);
		expect(required.stdout).not.toContain(secret);

		const singleProject = tempProject();
		writeAuth(singleProject, { admin: profile(secret) });
		writeFile(path.join(singleProject, "flow.jsonc"), '{"steps":[{"action":"goto","path":"/"}]}\n');
		const singleRequired = run(singleProject, ["run", "--flow", "flow.jsonc"]);
		expect(singleRequired).toMatchObject({ code: 43, json: { status: "QA_PROFILE_REQUIRED" } });
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
			writeAuth(project, { admin: profile("unused-secret", { auth }) });
			writeFile(path.join(project, "flow.jsonc"), '{"steps":[{"action":"goto","path":"/"}]}\n');
			const result = run(project, ["run", "--profile", "admin", "--flow", "flow.jsonc", "--run-id", `invalid-${index}`]);
			expect(result).toMatchObject({ code: 42, json: { status: "QA_AUTH_UPDATE_REQUIRED", profile: "admin" } });
		}
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
			}],
		];
		for (const [name, auth] of authModes) {
			const project = tempProject();
			writeAuth(project, { admin: profile("unused-secret", { auth }) });
			installFakePlaywright(project);
			writeFile(path.join(project, "flow.jsonc"), JSON.stringify({ steps: [{ action: "goto", path: "/settings" }] }));
			const result = run(project, ["run", "--profile", "admin", "--flow", "flow.jsonc", "--run-id", name]);
			expect(result).toMatchObject({ code: 0, json: { status: "QA_PASSED", profile: "admin" } });
			expect(fs.readFileSync(path.join(project, "http-route-blocked"), "utf8")).toBe("yes");
			expect(fs.readFileSync(path.join(project, "ws-route-blocked"), "utf8")).toBe("yes");
			expect(fs.readFileSync(path.join(project, "ws-route-allowed"), "utf8")).toBe("yes");
			if (name === "bearer") expect(fs.readFileSync(path.join(project, "allowed-route-headers"), "utf8")).toContain("bearer-secret");
		}

		const storageProject = tempProject();
		const stateFile = path.join(storageProject, ".pi", "imported-state.json");
		writeFile(stateFile, JSON.stringify({ cookies: [], origins: [] }));
		fs.chmodSync(stateFile, 0o600);
		writeAuth(storageProject, { admin: profile("unused-secret", { auth: { type: "storageState", path: ".pi/imported-state.json" } }) });
		installFakePlaywright(storageProject);
		writeFile(path.join(storageProject, "flow.jsonc"), JSON.stringify({ steps: [{ action: "goto", path: "/settings" }] }));
		const storageResult = run(storageProject, ["run", "--profile", "admin", "--flow", "flow.jsonc", "--run-id", "storage"]);
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
		writeAuth(symlinked, { admin: profile("top-secret-cookie") });
		installFakePlaywright(symlinked);
		const realFlow = path.join(symlinked, "real-flow.jsonc");
		writeFile(realFlow, '{"steps":[{"action":"goto","path":"/"}]}');
		fs.symlinkSync(realFlow, path.join(symlinked, "flow.jsonc"));
		const symlinkResult = run(symlinked, ["run", "--profile", "admin", "--flow", "flow.jsonc", "--run-id", "symlink"]);
		expect(symlinkResult).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED" } });
		expect(symlinkResult.json.reason).toContain("symbolic links");

		const collision = tempProject();
		writeAuth(collision, { admin: profile("top-secret-cookie") });
		installFakePlaywright(collision);
		writeFile(path.join(collision, "flow.jsonc"), '{"steps":[{"action":"goto","path":"/"}]}');
		const evidenceDir = path.join(collision, ".pi", "qa-runs", "proof", "admin");
		fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
		fs.chmodSync(path.join(collision, ".pi", "qa-runs"), 0o700);
		fs.chmodSync(path.join(collision, ".pi", "qa-runs", "proof"), 0o700);
		writeFile(path.join(evidenceDir, "keep"), "original");
		const collisionResult = run(collision, ["run", "--profile", "admin", "--flow", "flow.jsonc", "--run-id", "proof"]);
		expect(collisionResult).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED" } });
		expect(fs.readFileSync(path.join(evidenceDir, "keep"), "utf8")).toBe("original");
	});

	test("never executes a model-authored JavaScript file", () => {
		const project = tempProject();
		writeAuth(project, { admin: profile("top-secret-cookie") });
		installFakePlaywright(project);
		writeFile(path.join(project, "flow.cjs"), "require('node:fs').writeFileSync('executed', 'yes');\n");
		const result = run(project, ["run", "--profile", "admin", "--flow", "flow.cjs", "--run-id", "code"]);
		expect(result).toMatchObject({ code: 1, json: { status: "QA_RUN_FAILED", profile: "admin" } });
		expect(fs.existsSync(path.join(project, "executed"))).toBe(false);
	});

	test("rejects missing config and disallowed base URLs with update-required status", () => {
		const missing = run(tempProject(), ["profiles"]);
		expect(missing).toMatchObject({ code: 42, json: { status: "QA_AUTH_UPDATE_REQUIRED", file: ".pi/qa_auth.jsonc" } });

		const project = tempProject();
		writeAuth(project, { admin: profile("top-secret-cookie") });
		writeFile(path.join(project, "flow.jsonc"), '{"steps":[{"action":"goto","path":"/"}]}\n');
		const rejected = run(project, ["run", "--profile", "admin", "--base-url", "https://evil.example", "--flow", "flow.jsonc"]);
		expect(rejected).toMatchObject({ code: 42, json: { status: "QA_AUTH_UPDATE_REQUIRED", profile: "admin" } });
		expect(rejected.json.reason).toContain("allowedOrigins");
		expect(rejected.stdout).not.toContain("top-secret-cookie");
	});

	test("creates isolated screenshot, video, trace, and redacted result evidence", () => {
		const project = tempProject();
		const secret = "top-secret-cookie";
		writeAuth(project, { admin: profile(secret) });
		installFakePlaywright(project);
		writeFile(path.join(project, "flow.jsonc"), JSON.stringify({ steps: [
			{ action: "goto", path: "/settings" },
			{ action: "assertURL", equals: "https://staging.example.test/settings" },
		] }));

		const result = run(project, ["run", "--profile", "admin", "--flow", "flow.jsonc", "--run-id", "proof"]);
		expect(result).toMatchObject({
			code: 0,
			stderr: "",
			json: { status: "QA_PASSED", profile: "admin", evidenceDir: ".pi/qa-runs/proof/admin" },
		});
		expect(result.json.evidence.sort()).toEqual(["final.png", "trace.zip", "video.webm"]);
		const evidenceDir = path.join(project, ".pi", "qa-runs", "proof", "admin");
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
	});

	test("turns application auth rejection into a redacted update request", () => {
		const project = tempProject();
		const secret = "top-secret-cookie";
		writeAuth(project, { admin: profile(secret) });
		installFakePlaywright(project);
		writeFile(path.join(project, "flow.jsonc"), JSON.stringify({ steps: [
			{ action: "goto", path: "/login" },
			{ action: "authRejectedIf", urlIncludes: "/login" },
		] }));

		const result = run(project, ["run", "--profile", "admin", "--flow", "flow.jsonc", "--run-id", "expired"]);
		expect(result).toMatchObject({
			code: 42,
			json: { status: "QA_AUTH_UPDATE_REQUIRED", profile: "admin", file: ".pi/qa_auth.jsonc" },
		});
		expect(result.json.reason).toContain("rejected or expired");
		expect(result.stdout).not.toContain(secret);
	});
});
