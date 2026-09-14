import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CHROME_DEVTOOLS_DRIVER,
	CHROME_DEVTOOLS_ONLY_ACTIONS,
	chromeDevtoolsRequiredByFlow,
	probeChromeDevtoolsProvider,
	runChromeDevtoolsProvider,
} from "../drivers/chrome-devtools/chrome-devtools-provider.mjs";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const INSTALLED_BROWSER_RUNNER = fileURLToPath(new URL("../browser/scripts/browser-qa-runner.mjs", import.meta.url));
const PLAYWRIGHT_DRIVER = "playwright-trusted-runner";

export function resolveBrowserDriver(flow) {
	const target = isObject(flow?.target) ? flow.target : {};
	const requested = target.browserDriver ?? "auto";
	if (!["auto", "playwright", "chrome-devtools"].includes(requested)) {
		throw new Error("target.browserDriver must be auto, playwright, or chrome-devtools");
	}
	if (requested !== "auto") return requested;
	if (typeof target.profile === "string") return "playwright";
	if (target.devtools !== undefined) return "chrome-devtools";
	return chromeDevtoolsRequiredByFlow(flow) ? "chrome-devtools" : "playwright";
}

export async function probeBrowserBackend(context = {}) {
	const driver = resolveBrowserDriver(context.flow);
	const target = isObject(context.flow?.target) ? context.flow.target : {};
	if (driver === "chrome-devtools") {
		if (typeof target.profile === "string") {
			return {
				available: false,
				guideTopic: "chrome-devtools",
				platformDriver: CHROME_DEVTOOLS_DRIVER,
				supportedCapabilities: [],
				missingCapabilities: ["trustedAuthentication"],
				reason: "target.profile authentication is owned by the trusted Playwright provider and cannot be delegated to Chrome DevTools",
				remediation: "use target.browserDriver `playwright` for QA credential profiles, or remove target.profile when the scenario does not require trusted authentication",
			};
		}
		return { ...(await probeChromeDevtoolsProvider(context)), guideTopic: "chrome-devtools" };
	}
	if (target.devtools !== undefined) {
		return {
			available: false,
			guideTopic: "playwright",
			platformDriver: PLAYWRIGHT_DRIVER,
			supportedCapabilities: [],
			missingCapabilities: ["chromeDevtoolsOptions"],
			reason: "target.devtools options cannot be applied by the Playwright provider",
			remediation: typeof target.profile === "string"
				? "remove target.devtools when using target.profile; trusted authentication is Playwright-owned"
				: "use target.browserDriver `chrome-devtools`, or leave it as `auto` so target.devtools selects Chrome DevTools",
		};
	}
	const devtoolsOnly = Array.isArray(context.flow?.steps)
		? [...new Set(context.flow.steps.map((step) => step?.action).filter((action) => CHROME_DEVTOOLS_ONLY_ACTIONS.has(action)))]
		: [];
	if (devtoolsOnly.length > 0) {
		return {
			available: false,
			guideTopic: "playwright",
			platformDriver: PLAYWRIGHT_DRIVER,
			supportedCapabilities: [],
			missingCapabilities: devtoolsOnly.map((action) => `action:${action}`),
			reason: `the Playwright provider does not implement these DevTools-only actions: ${devtoolsOnly.join(", ")}`,
			remediation: "use target.browserDriver `chrome-devtools`, or leave it as `auto` so DevTools-only actions select the Chrome DevTools provider",
		};
	}
	const runner = context.browserRunnerPath ?? INSTALLED_BROWSER_RUNNER;
	const available = fs.existsSync(runner) && fs.statSync(runner).isFile();
	return {
		available,
		guideTopic: "playwright",
		platformDriver: PLAYWRIGHT_DRIVER,
		supportedCapabilities: [
			"navigate", "semanticLocators", "pointerInput", "keyboardInput", "domState", "deterministicAssertions",
			"screenshot", "video", "trace", "downloads", "originIsolation", "trustedAuthentication", "ownedCleanup",
		],
		missingCapabilities: available ? [] : ["browserRunner"],
		reason: available ? "URL target selects the installed trusted browser runner" : "the installed trusted browser runner is missing",
		remediation: available ? undefined : "reinstall or update pi-tools-suite so the browser QA runner resource is present",
	};
}

export async function runBrowserBackend(context) {
	const config = validateBrowserFlow(context.flow);
	if (config.browserDriver === "chrome-devtools") {
		return runChromeDevtoolsProvider(context, config);
	}
	const generatedFlow = createAdapterFlow(context, config.flow);
	const args = ["run", "--flow", generatedFlow, "--run-id", context.runId];
	if (config.profile) args.push("--profile", config.profile);
	if (config.baseUrl) args.push("--base-url", config.baseUrl);
	for (const origin of config.additionalAllowedOrigins) args.push("--allow-origin", origin);
	const remaining = Math.max(100, Math.min(100_000, context.deadline - Date.now()));
	args.push("--runner-timeout-ms", String(remaining));
	context.progress("browser_adapter_started", { authenticated: Boolean(config.profile), allowedOriginCount: config.allowedOrigins.length });
	const execution = await runOwnedRunner(context.browserRunnerPath, args, {
		cwd: context.projectRoot,
		env: process.env,
		timeoutMs: remaining + 5_000,
	});
	const payload = parseRunnerPayload(execution.stdout);
	const status = normalizeStatus(payload?.status, execution.code, execution.timedOut);
	const artifacts = normalizeArtifacts(payload?.artifacts);
	const assertions = browserAssertionLedger(config.flow.steps, status);
	const reason = payload?.reason ?? (status === "PASSED" ? undefined : execution.stderr || `browser runner exited ${execution.code}`);
	context.progress("browser_adapter_finished", { status, legacyStatus: payload?.status, exitCode: execution.code });
	return {
		status,
		...(reason ? { reason } : {}),
		...(payload?.profile ? { profile: payload.profile } : {}),
		...(typeof payload?.file === "string" ? { file: payload.file } : {}),
		...(typeof payload?.action === "string" ? { action: payload.action } : {}),
		...(typeof payload?.templateCreated === "boolean" ? { templateCreated: payload.templateCreated } : {}),
		...(Number.isInteger(payload?.placeholderCount) ? { placeholderCount: payload.placeholderCount } : {}),
		...(payload?.remediation ? { remediation: payload.remediation } : {}),
		...(execution.timedOut || payload?.timedOut ? { timedOut: true } : {}),
		assertions,
		observations: Array.isArray(payload?.observations) ? payload.observations : [],
		artifacts,
		legacyBrowserResult: payload ? {
			status: payload.status,
			...(payload.evidenceDir ? { evidenceDir: payload.evidenceDir } : {}),
		} : undefined,
	};
}

function validateBrowserFlow(flow) {
	assertKnownFields(flow, new Set(["version", "target", "steps", "viewport", "environment", "timeoutMs"]), "browser flow");
	const target = flow.target;
	if (!isObject(target)) throw new Error("browser flow requires target");
	assertKnownFields(target, new Set(["kind", "url", "baseUrl", "profile", "allowedOrigins", "browserDriver", "devtools"]), "browser target");
	const rawUrl = target.url ?? target.baseUrl;
	const baseUrl = rawUrl === undefined ? undefined : normalizeHttpUrl(rawUrl, "target.url/baseUrl");
	const profile = target.profile === undefined ? undefined : safeName(target.profile, "target.profile");
	if (!profile && !baseUrl) throw new Error("public browser flow requires target.url or target.baseUrl");
	if (profile && baseUrl !== undefined) {
		// A profile may still use an explicit target URL, but the legacy runner owns its allowlist check.
	}
	const allowedOrigins = target.allowedOrigins === undefined ? [] : normalizeOrigins(target.allowedOrigins);
	const effectiveAllowedOrigins = [...new Set([
		...(baseUrl ? [new URL(baseUrl).origin] : []),
		...allowedOrigins,
	])];
	const browserDriver = resolveBrowserDriver(flow);
	const devtools = validateDevtoolsOptions(target.devtools);
	if (browserDriver === "chrome-devtools" && profile) throw new Error("Chrome DevTools browser provider does not accept target.profile authentication");
	if (browserDriver === "playwright" && target.devtools !== undefined) throw new Error("target.devtools options require browserDriver chrome-devtools or auto without target.profile");
	if (profile && target.devtools !== undefined) throw new Error("target.profile cannot be combined with target.devtools; trusted authentication is owned by the Playwright provider");
	if (!Array.isArray(flow.steps) || flow.steps.length < 1 || flow.steps.length > 100) throw new Error("browser flow requires 1..100 steps");
	for (const [index, step] of flow.steps.entries()) {
		if (!isObject(step) || typeof step.action !== "string") throw new Error(`browser step ${index + 1} must define an action`);
	}
	const adapter = { steps: flow.steps };
	for (const key of ["viewport", "environment", "timeoutMs"]) if (flow[key] !== undefined) adapter[key] = flow[key];
	return {
		baseUrl,
		profile,
		allowedOrigins: effectiveAllowedOrigins,
		additionalAllowedOrigins: allowedOrigins,
		browserDriver,
		devtools,
		flow: adapter,
		originalFlow: flow,
	};
}

function validateDevtoolsOptions(value) {
	if (value === undefined) return {};
	if (!isObject(value)) throw new Error("target.devtools must be an object");
	assertKnownFields(value, new Set(["headless", "browserUrl", "reuseExistingBrowserSession"]), "target.devtools");
	const result = {};
	if (value.headless !== undefined) {
		if (typeof value.headless !== "boolean") throw new Error("target.devtools.headless must be boolean");
		result.headless = value.headless;
	}
	if (value.browserUrl !== undefined) result.browserUrl = normalizeLoopbackBrowserUrl(value.browserUrl);
	if (value.reuseExistingBrowserSession !== undefined) {
		if (typeof value.reuseExistingBrowserSession !== "boolean") throw new Error("target.devtools.reuseExistingBrowserSession must be boolean");
		if (value.reuseExistingBrowserSession && !result.browserUrl) throw new Error("target.devtools.reuseExistingBrowserSession requires target.devtools.browserUrl");
		result.reuseExistingBrowserSession = value.reuseExistingBrowserSession;
	}
	return result;
}

function normalizeLoopbackBrowserUrl(value) {
	if (typeof value !== "string" || value.length > 500) throw new Error("target.devtools.browserUrl must be a bounded loopback URL");
	let url;
	try { url = new URL(value); } catch { throw new Error("target.devtools.browserUrl is not a valid URL"); }
	if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("target.devtools.browserUrl must be an exact credential-free http loopback origin");
	}
	const host = url.hostname.toLowerCase();
	if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) throw new Error("target.devtools.browserUrl must use localhost/loopback");
	return url.origin;
}

function createAdapterFlow(context, flow) {
	const browserFlows = path.join(context.agentDir, "browser-qa", "flows");
	validatePrivateDirectory(context.agentDir, path.join(context.agentDir, "browser-qa"), "browser QA workspace");
	validatePrivateDirectory(path.join(context.agentDir, "browser-qa"), browserFlows, "browser QA flow workspace");
	const file = path.join(browserFlows, `ui-qa-${context.runId}.jsonc`);
	if (fs.existsSync(file)) throw new Error("browser adapter flow already exists for this run id");
	fs.writeFileSync(file, `${JSON.stringify(flow, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	if (process.platform !== "win32") fs.chmodSync(file, 0o600);
	return file;
}

function runOwnedRunner(file, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [file, ...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let outputTruncated = false;
		let settled = false;
		const append = (current, chunk) => {
			const bytes = Buffer.from(chunk);
			if (current.length >= MAX_OUTPUT_BYTES) {
				outputTruncated = true;
				return current;
			}
			const kept = bytes.subarray(0, MAX_OUTPUT_BYTES - current.length);
			if (kept.length < bytes.length) outputTruncated = true;
			return Buffer.concat([current, kept]);
		};
		child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
		child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			killOwned(child.pid, "SIGKILL");
			resolve({ code: 124, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8").trim(), timedOut: true, outputTruncated });
		}, options.timeoutMs);
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code: code ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8").trim(), timedOut: false, outputTruncated });
		});
	});
}

function parseRunnerPayload(stdout) {
	for (const line of stdout.trim().split(/\r?\n/).reverse()) {
		try {
			const value = JSON.parse(line);
			if (isObject(value) && typeof value.status === "string") return value;
		} catch { /* progress or diagnostic line */ }
	}
	return undefined;
}

function normalizeStatus(status, exitCode, timedOut) {
	if (timedOut || exitCode === 124) return "FAILED";
	if (status === "QA_PASSED" || status === "passed" || status === "PASSED") return "PASSED";
	if (status === "QA_AUTH_UPDATE_REQUIRED" || status === "BLOCKED") return "BLOCKED";
	return "FAILED";
}

function normalizeArtifacts(value) {
	const source = isObject(value) ? value : {};
	const result = emptyArtifacts();
	for (const key of ["screenshots", "videos", "traces", "terminalCaptures", "accessibilitySnapshots", "observations", "downloads"]) {
		if (Array.isArray(source[key])) result[key] = source[key].filter((entry) => isObject(entry) && typeof entry.path === "string" && typeof entry.uri === "string");
	}
	return result;
}

function browserAssertionLedger(steps, status) {
	const assertions = steps.filter((step) => typeof step.action === "string" && step.action.startsWith("assert"));
	if (status !== "PASSED") return assertions.map((step) => ({ action: step.action, passed: undefined, delegated: true }));
	return assertions.map((step) => ({ action: step.action, passed: true, delegated: true }));
}

function normalizeOrigins(value) {
	if (!Array.isArray(value) || value.length > 20) throw new Error("target.allowedOrigins must be an array with at most 20 exact origins");
	return value.map((entry, index) => {
		const url = new URL(normalizeHttpUrl(entry, `target.allowedOrigins[${index}]`));
		if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error(`target.allowedOrigins[${index}] must be an exact origin`);
		return url.origin;
	});
}

function normalizeHttpUrl(value, label) {
	if (typeof value !== "string" || value.length > 4096) throw new Error(`${label} must be a bounded URL`);
	let url;
	try { url = new URL(value); } catch { throw new Error(`${label} is not a valid URL`); }
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} must use http or https`);
	if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
	return url.href;
}

function safeName(value, label) {
	if (typeof value !== "string" || !SAFE_NAME.test(value) || value.includes("..")) throw new Error(`${label} must be a safe identifier`);
	return value;
}

function validatePrivateDirectory(root, target, label) {
	if (!isInside(root, target) || !fs.existsSync(target)) throw new Error(`${label} is missing or outside its owning agent directory`);
	const stat = fs.lstatSync(target);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory`);
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`${label} must use private permissions (0700)`);
}

function killOwned(pid, signal) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform !== "win32") {
		try { process.kill(-pid, signal); return; } catch { /* fall back to the exact owned pid */ }
	}
	try { process.kill(pid, signal); } catch { /* already exited */ }
}

function assertKnownFields(value, allowed, label) {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
}

function emptyArtifacts() {
	return { screenshots: [], videos: [], traces: [], terminalCaptures: [], accessibilitySnapshots: [], observations: [], downloads: [] };
}

function isInside(root, target) {
	const relative = path.relative(root, target);
	return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
