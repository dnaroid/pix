import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MINIMUM_CLI_VERSION = [1, 9, 0];
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const MAX_ACTION_TIMEOUT_MS = 60_000;
const POLL_MS = 150;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export const CHROME_DEVTOOLS_DRIVER = "chrome-devtools-cli";
export const CHROME_DEVTOOLS_ONLY_ACTIONS = new Set([
	"snapshotAccessibility",
	"assertNoConsoleErrors",
	"assertConsole",
	"assertNetworkRequest",
	"lighthouse",
	"performanceTrace",
	"heapSummary",
]);

export const CHROME_DEVTOOLS_SUPPORTED_ACTIONS = new Set([
	"goto",
	"reload",
	"click",
	"doubleClick",
	"hover",
	"fill",
	"press",
	"waitFor",
	"waitForTimeout",
	"assertVisible",
	"assertText",
	"assertURL",
	"screenshot",
	...CHROME_DEVTOOLS_ONLY_ACTIONS,
]);

export function chromeDevtoolsRequiredByFlow(flow) {
	return Array.isArray(flow?.steps) && flow.steps.some((step) => CHROME_DEVTOOLS_ONLY_ACTIONS.has(step?.action));
}

export function unsupportedChromeDevtoolsActions(flow) {
	if (!Array.isArray(flow?.steps)) return [];
	return [...new Set(flow.steps
		.map((step) => step?.action)
		.filter((action) => typeof action === "string" && !CHROME_DEVTOOLS_SUPPORTED_ACTIONS.has(action)))];
}

export async function probeChromeDevtoolsProvider(context = {}) {
	const executable = resolveChromeDevtoolsExecutable(context.chromeDevtoolsPath);
	const supportedCapabilities = [
		"navigate", "semanticLocators", "pointerInput", "keyboardInput", "accessibilityTree",
		"deterministicAssertions", "screenshot", "originIsolation", "consoleInspection",
		"networkInspection", "lighthouse", "performanceTrace", "memorySummary", "ownedCleanup",
	];
	if (!executable) {
		return {
			available: false,
			platformDriver: CHROME_DEVTOOLS_DRIVER,
			supportedCapabilities: [],
			missingCapabilities: ["chromeDevtoolsCli"],
			reason: "Chrome DevTools browser QA requires the chrome-devtools CLI, but it is not available on PATH",
			remediation: "install chrome-devtools-mcp with `npm install -g chrome-devtools-mcp@latest`, verify `chrome-devtools --version`, then rerun UI QA",
		};
	}

	const version = probeCliVersion(executable);
	if (!version || compareVersions(version.parts, MINIMUM_CLI_VERSION) < 0) {
		return {
			available: false,
			platformDriver: CHROME_DEVTOOLS_DRIVER,
			supportedCapabilities: [],
			missingCapabilities: ["chromeDevtoolsCli>=1.9.0"],
			reason: version
				? `Chrome DevTools browser QA requires chrome-devtools-mcp >= 1.9.0; found ${version.raw}`
				: "Chrome DevTools browser QA could not determine the installed chrome-devtools CLI version",
			remediation: "upgrade with `npm install -g chrome-devtools-mcp@latest`, verify `chrome-devtools --version`, then rerun UI QA",
		};
	}

	const unsupported = unsupportedChromeDevtoolsActions(context.flow);
	if (unsupported.length > 0) {
		return {
			available: false,
			platformDriver: CHROME_DEVTOOLS_DRIVER,
			supportedCapabilities,
			missingCapabilities: unsupported.map((action) => `action:${action}`),
			reason: `the Chrome DevTools provider does not support these requested flow actions: ${unsupported.join(", ")}`,
			remediation: "use browserDriver `playwright` for Playwright-only actions, or split DevTools diagnostics into a separate Chrome DevTools UI-QA flow",
		};
	}
	if (context.flow?.environment !== undefined) {
		return {
			available: false,
			platformDriver: CHROME_DEVTOOLS_DRIVER,
			supportedCapabilities,
			missingCapabilities: ["deterministicBrowserEnvironment"],
			reason: "the Chrome DevTools provider does not currently reproduce the Playwright locale/timezone/reduced-motion environment contract",
			remediation: "use browserDriver `playwright` when a deterministic browser environment is part of the acceptance surface, or split DevTools diagnostics into a separate flow without top-level environment overrides",
		};
	}

	return {
		available: true,
		platformDriver: CHROME_DEVTOOLS_DRIVER,
		supportedCapabilities,
		missingCapabilities: ["video", "trustedAuthentication", "downloads"],
		reason: `Chrome DevTools CLI ${version.raw} is available with an isolated per-run daemon, exact-origin network restrictions, redacted network headers, and JavaScript evaluation disabled`,
		remediation: undefined,
		executable,
	};
}

export function chromeDevtoolsStartArgs({ sessionId, evidenceDir, allowedOrigins, devtools = {} }) {
	const args = [
		"start",
		"--sessionId", sessionId,
		"--redactNetworkHeaders=true",
		"--usageStatistics=false",
		"--performanceCrux=false",
		"--pageIdRouting=true",
		"--javascriptEvaluation=false",
		"--categoryExtensions=false",
		"--categoryPwa=false",
		"--categoryExperimentalThirdParty=false",
		"--categoryExperimentalWebmcp=false",
		"--experimentalVision=false",
		`--workspace=${evidenceDir}`,
	];
	for (const origin of allowedOrigins) args.push(`--allowedUrlPattern=${origin}/*`);
	if (devtools.browserUrl) args.push(`--browserUrl=${devtools.browserUrl}`);
	else {
		args.push("--isolated=true");
		args.push(`--headless=${devtools.headless !== false}`);
	}
	return args;
}

export async function runChromeDevtoolsProvider(context, config) {
	const probe = await probeChromeDevtoolsProvider({ ...context, flow: config.originalFlow });
	if (!probe.available) return blocked(probe.reason, probe.remediation);
	if (config.profile) {
		return blocked(
			"Chrome DevTools browser QA does not consume trusted QA credential profiles",
			"use browserDriver `playwright` for target.profile authentication; Chrome DevTools may only reuse a live browser session when the task explicitly authorizes devtools.browserUrl plus reuseExistingBrowserSession",
		);
	}

	const executable = probe.executable;
	// chrome-devtools-mcp intentionally restricts daemon session ids to hex and
	// hyphens because the value is embedded in its private socket/runtime paths.
	// A 128-bit random hex id gives this run an isolated daemon namespace without
	// colliding with the user's default or other QA sessions.
	const sessionId = randomBytes(16).toString("hex");
	const environment = chromeDevtoolsEnvironment();
	const assertions = [];
	const observations = [];
	const artifacts = emptyArtifacts();
	let pageId;
	let daemonStarted = false;
	let failure;

	try {
		const startArgs = chromeDevtoolsStartArgs({
			sessionId,
			evidenceDir: context.evidenceDir,
			allowedOrigins: config.allowedOrigins,
			devtools: config.devtools,
		});
		const start = await runCliProcess(executable, startArgs, {
			cwd: context.projectRoot,
			env: environment,
			timeoutMs: boundedRemaining(context, 20_000),
		});
		if (start.code !== 0) {
			// `start` normally either succeeds atomically or leaves no daemon, but
			// stop this private session best-effort in case startup failed after the
			// daemon socket/PID had already been created.
			await runCliProcess(executable, ["stop", "--sessionId", sessionId], {
				cwd: context.projectRoot,
				env: environment,
				timeoutMs: 5_000,
			}).catch(() => {});
			return blocked(
				"Chrome DevTools CLI could not start its isolated UI-QA daemon/browser with the required safety policy",
				`verify Chrome 149+ is installed and that chrome-devtools-mcp can start with allowedUrlPattern; ${safeCliFailure(start)}`,
			);
		}
		daemonStarted = true;
		observations.push({
			action: "browserProvider",
			provider: CHROME_DEVTOOLS_DRIVER,
			isolatedDaemon: true,
			attachedExistingChrome: Boolean(config.devtools.browserUrl),
			reuseExistingBrowserSession: Boolean(config.devtools.reuseExistingBrowserSession),
			javascriptEvaluation: false,
			networkHeadersRedacted: true,
			allowedOriginCount: config.allowedOrigins.length,
		});

		const page = await invokeCliJson(executable, sessionId, "new_page", [
			config.baseUrl,
			...(config.devtools.browserUrl && !config.devtools.reuseExistingBrowserSession
				? ["--isolatedContext", sessionId]
				: []),
			"--timeout", String(Math.min(30_000, boundedRemaining(context, 30_000))),
		], context, environment);
		pageId = selectedPageId(page, config.baseUrl);
		if (!Number.isInteger(pageId)) throw new Error("Chrome DevTools did not return a task-owned page id");
		const viewport = validateDevtoolsViewport(config.flow.viewport);
		if (viewport) {
			await invokeCliJson(executable, sessionId, "resize_page", [String(pageId), String(viewport.width), String(viewport.height)], context, environment);
			observations.push({ action: "viewport", width: viewport.width, height: viewport.height });
		}
		await assertPageOriginAllowed(executable, sessionId, pageId, config.allowedOrigins, context, environment);
		observations.push({ action: "newPage", pageId, isolatedContext: !config.devtools.reuseExistingBrowserSession });

		for (let index = 0; index < config.originalFlow.steps.length; index += 1) {
			const step = validateDevtoolsStep(config.originalFlow.steps[index], index);
			context.progress("browser_devtools_action_started", { index, action: step.action });
			try {
				await executeStep({ executable, sessionId, pageId, step, index, context, config, environment, assertions, observations, artifacts });
				if (["goto", "reload", "click", "doubleClick", "fill", "press"].includes(step.action)) {
					await assertPageOriginAllowed(executable, sessionId, pageId, config.allowedOrigins, context, environment);
				}
				context.progress("browser_devtools_action_finished", { index, action: step.action });
			} catch (error) {
				failure = new Error(`step ${index + 1} (${step.action}) failed: ${safeReason(error)}`);
				break;
			}
		}

		if (!failure) {
			await captureAccessibility({ executable, sessionId, pageId, context, environment, artifacts, name: "final", verbose: false }).catch((error) => {
				observations.push({ action: "finalSnapshot", status: "unavailable", reason: safeReason(error) });
			});
		}
	} catch (error) {
		failure = error;
	} finally {
		if (failure && Number.isInteger(pageId)) {
			await captureAccessibility({ executable, sessionId, pageId, context, environment, artifacts, name: "failure", verbose: false }).catch(() => {});
			await captureScreenshot({ executable, sessionId, pageId, context, environment, artifacts, name: "failure", fullPage: true }).catch(() => {});
		}
		if (Number.isInteger(pageId)) {
			await invokeCliJson(executable, sessionId, "close_page", [String(pageId)], context, environment, 5_000).catch(() => {});
		}
		if (daemonStarted) {
			await runCliProcess(executable, ["stop", "--sessionId", sessionId], {
				cwd: context.projectRoot,
				env: environment,
				timeoutMs: 8_000,
			}).catch(() => {});
		}
	}

	return {
		status: failure ? "FAILED" : "PASSED",
		...(failure ? { reason: safeReason(failure) } : {}),
		assertions,
		observations,
		artifacts,
	};
}

async function executeStep(options) {
	const { executable, sessionId, pageId, step, index, context, config, environment, assertions, observations, artifacts } = options;
	const timeoutMs = boundedActionTimeout(step.timeoutMs ?? config.flow.timeoutMs, context);
	switch (step.action) {
		case "goto": {
			const target = typeof step.url === "string" ? step.url : step.path;
			if (typeof target !== "string") throw new Error("goto requires url or path");
			const url = new URL(target, config.baseUrl);
			assertAllowedUrl(url, config.allowedOrigins, "goto");
			await invokeCliJson(executable, sessionId, "navigate_page", [String(pageId), "--type", "url", "--url", url.href, "--timeout", String(timeoutMs)], context, environment);
			observations.push({ action: "goto", origin: url.origin, path: url.pathname });
			return;
		}
		case "reload":
			await invokeCliJson(executable, sessionId, "navigate_page", [String(pageId), "--type", "reload", "--timeout", String(timeoutMs)], context, environment);
			observations.push({ action: "reload" });
			return;
		case "click":
		case "doubleClick":
		case "hover":
		case "fill":
		case "press": {
			const snapshot = await takeSnapshot(executable, sessionId, pageId, context, environment);
			const node = requireLocatorNode(snapshot, step.locator);
			if (step.action === "click" || step.action === "doubleClick") {
				await invokeCliJson(executable, sessionId, "click", [String(pageId), node.id, ...(step.action === "doubleClick" ? ["--dblClick", "true"] : [])], context, environment);
			} else if (step.action === "hover") {
				await invokeCliJson(executable, sessionId, "hover", [String(pageId), node.id], context, environment);
			} else if (step.action === "fill") {
				await invokeCliJson(executable, sessionId, "fill", [String(pageId), node.id, step.value], context, environment);
			} else {
				await invokeCliJson(executable, sessionId, "click", [String(pageId), node.id], context, environment);
				await invokeCliJson(executable, sessionId, "press_key", [String(pageId), step.key], context, environment);
			}
			observations.push({ action: step.action, locator: publicLocator(step.locator) });
			return;
		}
		case "waitFor": {
			const state = step.state ?? "visible";
			if (state !== "visible" && state !== "hidden") throw new Error("Chrome DevTools waitFor supports only visible or hidden state");
			await retryUntil(async () => {
				const snapshot = await takeSnapshot(executable, sessionId, pageId, context, environment);
				const count = findLocatorNodes(snapshot, step.locator).length;
				return state === "visible" ? count === 1 : count === 0;
			}, timeoutMs, `locator did not become ${state}`);
			observations.push({ action: "waitFor", state, locator: publicLocator(step.locator) });
			return;
		}
		case "waitForTimeout":
			await sleep(step.timeoutMs);
			observations.push({ action: "waitForTimeout", durationMs: step.timeoutMs });
			return;
		case "assertVisible": {
			await retryUntil(async () => {
				const snapshot = await takeSnapshot(executable, sessionId, pageId, context, environment);
				return findLocatorNodes(snapshot, step.locator).length === 1;
			}, timeoutMs, "expected locator to be visible and unambiguous");
			assertions.push({ action: step.action, locator: publicLocator(step.locator), passed: true });
			return;
		}
		case "assertText": {
			const matcher = stringMatcher(step, "assertText");
			await retryUntil(async () => {
				const snapshot = await takeSnapshot(executable, sessionId, pageId, context, environment);
				const nodes = findLocatorNodes(snapshot, step.locator);
				return nodes.length === 1 && matcher.matches(nodeText(nodes[0]));
			}, timeoutMs, "text assertion failed");
			assertions.push({ action: step.action, locator: publicLocator(step.locator), expected: matcher.publicExpected, passed: true });
			return;
		}
		case "assertURL": {
			const matcher = stringMatcher(step, "assertURL");
			await retryUntil(async () => matcher.matches((await pageRecord(executable, sessionId, pageId, context, environment)).url), timeoutMs, "URL assertion failed");
			assertions.push({ action: step.action, expected: matcher.publicExpected, passed: true });
			return;
		}
		case "screenshot":
			await captureScreenshot({ executable, sessionId, pageId, context, environment, artifacts, name: evidenceName(step.name, index, "screenshot"), fullPage: step.fullPage !== false });
			return;
		case "snapshotAccessibility":
			await captureAccessibility({ executable, sessionId, pageId, context, environment, artifacts, name: evidenceName(step.name, index, "snapshot"), verbose: step.verbose === true });
			return;
		case "assertNoConsoleErrors": {
			const data = await invokeCliJson(executable, sessionId, "list_console_messages", [String(pageId), "--types", "error", "--pageSize", "200"], context, environment);
			const count = Array.isArray(data.consoleMessages) ? data.consoleMessages.length : 0;
			const passed = count === 0;
			assertions.push({ action: step.action, expected: { consoleErrors: 0 }, actual: { consoleErrors: count }, passed });
			if (!passed) throw new Error("console contains error messages");
			return;
		}
		case "assertConsole": {
			const matcher = stringMatcher(step, "assertConsole");
			await retryUntil(async () => {
				const args = [String(pageId), "--pageSize", "200"];
				if (step.type) args.push("--types", step.type);
				const data = await invokeCliJson(executable, sessionId, "list_console_messages", args, context, environment);
				return (data.consoleMessages ?? []).some((message) => matcher.matches(String(message?.text ?? "")));
			}, timeoutMs, "console assertion failed");
			assertions.push({ action: step.action, ...(step.type ? { type: step.type } : {}), expected: matcher.publicExpected, passed: true });
			return;
		}
		case "assertNetworkRequest": {
			await retryUntil(async () => {
				const data = await invokeCliJson(executable, sessionId, "list_network_requests", [String(pageId), "--pageSize", "200"], context, environment);
				return (data.networkRequests ?? []).some((request) => networkRequestMatches(request, step, config.allowedOrigins));
			}, timeoutMs, "network request assertion failed");
			assertions.push({
				action: step.action,
				expected: { path: step.path, method: step.method, status: step.status, ...(step.origin ? { origin: step.origin } : {}) },
				passed: true,
			});
			return;
		}
		case "lighthouse": {
			const data = await invokeCliJson(executable, sessionId, "lighthouse_audit", [
				String(pageId),
				...(step.mode ? ["--mode", step.mode] : []),
				...(step.device ? ["--device", step.device] : []),
			], context, environment, Math.min(60_000, boundedRemaining(context, 60_000)));
			const summary = sanitizeLighthouseSummary(data.lighthouseResult?.summary);
			if (!summary) throw new Error("Lighthouse did not return a summary");
			const name = `${evidenceName(step.name, index, "lighthouse")}.json`;
			writeJsonArtifact(context, artifacts, "observations", name, summary, "lighthouse summary");
			observations.push({ action: "lighthouse", scores: summary.scores });
			return;
		}
		case "performanceTrace": {
			const base = evidenceName(step.name, index, "performance-trace");
			const rawPath = path.join(context.evidenceDir, `${base}.raw.json`);
			try {
				const data = await invokeCliJson(executable, sessionId, "performance_start_trace", [
					String(pageId),
					"--reload", String(step.reload !== false),
					"--autoStop", "true",
					"--filePath", rawPath,
				], context, environment, Math.min(30_000, boundedRemaining(context, 30_000)));
				const summary = sanitizePerformanceTrace(data);
				const summaryName = `${base}.json`;
				writeJsonArtifact(context, artifacts, "traces", summaryName, summary, "sanitized performance trace summary");
				observations.push({ action: "performanceTrace", rawTraceRetained: false, insightCount: summary.insightNames.length, metrics: summary.metrics });
			} finally {
				// Raw Chrome trace data can contain URLs, query strings, network details,
				// call frames, and response metadata. It is an implementation scratch
				// artifact only; publish the bounded sanitized summary above instead.
				fs.rmSync(rawPath, { force: true });
			}
			return;
		}
		case "heapSummary": {
			const base = evidenceName(step.name, index, "heap-summary");
			const rawName = `${base}.heapsnapshot`;
			const rawPath = path.join(context.evidenceDir, rawName);
			try {
				await invokeCliJson(executable, sessionId, "take_heapsnapshot", [String(pageId), rawPath], context, environment, Math.min(60_000, boundedRemaining(context, 60_000)));
				const data = await invokeCliJson(executable, sessionId, "get_heapsnapshot_summary", [rawPath], context, environment, Math.min(60_000, boundedRemaining(context, 60_000)));
				const safeSummary = sanitizeHeapSummary(data.heapSnapshot);
				const summaryName = `${base}.json`;
				writeJsonArtifact(context, artifacts, "observations", summaryName, safeSummary, "heap summary");
				observations.push({ action: "heapSummary", rawSnapshotRetained: false });
			} finally {
				await invokeCliJson(executable, sessionId, "close_heapsnapshot", [rawPath], context, environment, 5_000).catch(() => {});
				fs.rmSync(rawPath, { force: true });
			}
			return;
		}
		default:
			throw new Error(`unsupported Chrome DevTools browser action: ${step.action}`);
	}
}

function validateDevtoolsStep(value, index) {
	if (!isObject(value) || typeof value.action !== "string" || !CHROME_DEVTOOLS_SUPPORTED_ACTIONS.has(value.action)) {
		throw new Error(`Chrome DevTools step ${index + 1} uses an unsupported action`);
	}
	const allowed = {
		goto: ["action", "url", "path", "timeoutMs"],
		reload: ["action", "timeoutMs"],
		click: ["action", "locator", "timeoutMs"],
		doubleClick: ["action", "locator", "timeoutMs"],
		hover: ["action", "locator", "timeoutMs"],
		fill: ["action", "locator", "value", "timeoutMs"],
		press: ["action", "locator", "key", "timeoutMs"],
		waitFor: ["action", "locator", "state", "timeoutMs"],
		waitForTimeout: ["action", "timeoutMs"],
		assertVisible: ["action", "locator", "timeoutMs"],
		assertText: ["action", "locator", "equals", "includes", "timeoutMs"],
		assertURL: ["action", "equals", "includes", "timeoutMs"],
		screenshot: ["action", "name", "fullPage"],
		snapshotAccessibility: ["action", "name", "verbose"],
		assertNoConsoleErrors: ["action"],
		assertConsole: ["action", "type", "equals", "includes", "timeoutMs"],
		assertNetworkRequest: ["action", "path", "method", "status", "origin", "timeoutMs"],
		lighthouse: ["action", "name", "mode", "device"],
		performanceTrace: ["action", "name", "reload"],
		heapSummary: ["action", "name"],
	}[value.action];
	assertKnownFields(value, new Set(allowed), `Chrome DevTools step ${index + 1}`);

	if (["click", "doubleClick", "hover", "fill", "press", "waitFor", "assertVisible", "assertText"].includes(value.action)) validateLocator(value.locator);
	if (value.action === "fill" && typeof value.value !== "string") throw new Error("fill requires a string value");
	if (value.action === "press" && (typeof value.key !== "string" || value.key.length < 1 || value.key.length > 80)) throw new Error("press requires a bounded key");
	if (value.action === "waitForTimeout" && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 5_000)) throw new Error("waitForTimeout must be between 1 and 5000 ms");
	if (value.action === "assertConsole" && value.type !== undefined && !["error", "warning", "info", "log", "debug", "table", "trace"].includes(value.type)) throw new Error("assertConsole.type is unsupported");
	if (value.action === "assertNetworkRequest") {
		if (typeof value.path !== "string" || !value.path.startsWith("/") || value.path.includes("?") || value.path.includes("#") || value.path.length > 2048) throw new Error("assertNetworkRequest.path must be an exact origin-relative path without query or fragment");
		if (typeof value.method !== "string" || !/^[A-Z]{3,12}$/.test(value.method)) throw new Error("assertNetworkRequest.method must be uppercase HTTP method text");
		if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599) throw new Error("assertNetworkRequest.status must be 100..599");
	}
	if (value.action === "lighthouse") {
		if (value.mode !== undefined && !["navigation", "snapshot"].includes(value.mode)) throw new Error("lighthouse.mode is unsupported");
		if (value.device !== undefined && !["mobile", "desktop"].includes(value.device)) throw new Error("lighthouse.device is unsupported");
	}
	if (value.name !== undefined) evidenceName(value.name, index, value.action);
	return value;
}

function validateLocator(value) {
	if (!isObject(value)) throw new Error("Chrome DevTools locator must be an object");
	assertKnownFields(value, new Set(["role", "name", "text", "exact"]), "Chrome DevTools locator");
	if (value.exact !== undefined && typeof value.exact !== "boolean") throw new Error("Chrome DevTools locator.exact must be boolean");
	if (value.role !== undefined) {
		if (typeof value.role !== "string" || value.role.length < 1 || value.role.length > 80) throw new Error("Chrome DevTools locator.role must be bounded text");
		if (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 500)) throw new Error("Chrome DevTools locator.name must be bounded text");
		if (value.text !== undefined) throw new Error("Chrome DevTools locator cannot combine role/name with text");
		return;
	}
	if (typeof value.text !== "string" || value.text.length < 1 || value.text.length > 500) throw new Error("Chrome DevTools locator requires role or text");
	if (value.name !== undefined) throw new Error("Chrome DevTools locator.name requires role");
}

function validateDevtoolsViewport(value) {
	if (value === undefined) return undefined;
	if (!isObject(value)) throw new Error("viewport must be an object");
	assertKnownFields(value, new Set(["width", "height"]), "viewport");
	if (!Number.isInteger(value.width) || value.width < 320 || value.width > 3840) throw new Error("viewport.width must be 320..3840");
	if (!Number.isInteger(value.height) || value.height < 240 || value.height > 2160) throw new Error("viewport.height must be 240..2160");
	return { width: value.width, height: value.height };
}

async function takeSnapshot(executable, sessionId, pageId, context, environment, verbose = false) {
	const data = await invokeCliJson(executable, sessionId, "take_snapshot", [String(pageId), "--verbose", String(verbose)], context, environment);
	if (!isObject(data.snapshot)) throw new Error("Chrome DevTools accessibility snapshot is unavailable");
	return data.snapshot;
}

async function captureAccessibility(options) {
	const { executable, sessionId, pageId, context, environment, artifacts, name, verbose } = options;
	const snapshot = await takeSnapshot(executable, sessionId, pageId, context, environment, verbose);
	const fileName = `${name}.accessibility.json`;
	writeJsonArtifact(context, artifacts, "accessibilitySnapshots", fileName, snapshot, "Chrome DevTools accessibility snapshot");
}

async function captureScreenshot(options) {
	const { executable, sessionId, pageId, context, environment, artifacts, name, fullPage } = options;
	const fileName = `${name}.png`;
	const destination = path.join(context.evidenceDir, fileName);
	await invokeCliJson(executable, sessionId, "take_screenshot", [String(pageId), "--format", "png", "--fullPage", String(fullPage), "--filePath", destination], context, environment);
	if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) throw new Error("Chrome DevTools screenshot was not written");
	artifacts.screenshots.push({ ...context.artifact(fileName, "Chrome DevTools screenshot"), format: "png" });
}

function writeJsonArtifact(context, artifacts, bucket, fileName, value, kind) {
	const destination = path.join(context.evidenceDir, fileName);
	fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
	artifacts[bucket].push({ ...context.artifact(fileName, kind), format: "json" });
}

function findLocatorNodes(snapshot, locator) {
	validateLocator(locator);
	const nodes = flattenSnapshot(snapshot);
	const exact = locator.exact === true;
	if (locator.role) {
		return nodes.filter((node) => {
			if (String(node.role ?? "").toLowerCase() !== locator.role.toLowerCase()) return false;
			if (locator.name === undefined) return true;
			return textMatches(String(node.name ?? ""), locator.name, exact);
		});
	}
	return nodes.filter((node) => textMatches(nodeText(node), locator.text, exact));
}

function requireLocatorNode(snapshot, locator) {
	const matches = findLocatorNodes(snapshot, locator);
	if (matches.length === 0) throw new Error("Chrome DevTools locator matched no accessibility node");
	if (matches.length > 1) throw new Error(`Chrome DevTools locator is ambiguous (${matches.length} accessibility nodes)`);
	if (typeof matches[0].id !== "string" || matches[0].id.length === 0) throw new Error("Chrome DevTools accessibility node has no UID");
	return matches[0];
}

function flattenSnapshot(root) {
	const result = [];
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!isObject(node)) continue;
		result.push(node);
		if (Array.isArray(node.children)) for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
	}
	return result;
}

function nodeText(node) {
	return [node.name, node.value, node.description, node.placeholder]
		.filter((value) => typeof value === "string" && value.length > 0)
		.join(" ");
}

function textMatches(actual, expected, exact) {
	return exact ? actual === expected : actual.includes(expected);
}

function publicLocator(locator) {
	return {
		...(locator.role ? { role: locator.role } : {}),
		...(locator.name !== undefined ? { name: locator.name } : {}),
		...(locator.text !== undefined ? { text: locator.text } : {}),
		...(locator.exact === true ? { exact: true } : {}),
	};
}

function stringMatcher(step, label) {
	const hasEquals = typeof step.equals === "string";
	const hasIncludes = typeof step.includes === "string";
	if (hasEquals === hasIncludes) throw new Error(`${label} requires exactly one of equals or includes`);
	const expected = hasEquals ? step.equals : step.includes;
	if (expected.length > 4096) throw new Error(`${label} matcher is too long`);
	return {
		matches: (actual) => hasEquals ? actual === expected : actual.includes(expected),
		publicExpected: hasEquals ? { equals: expected } : { includes: expected },
	};
}

function networkRequestMatches(request, step, allowedOrigins) {
	if (!isObject(request) || typeof request.url !== "string") return false;
	let url;
	try { url = new URL(request.url); } catch { return false; }
	if (!allowedOrigins.includes(url.origin)) return false;
	if (step.origin !== undefined && url.origin !== step.origin) return false;
	const status = typeof request.status === "string" && /^\d{3}$/.test(request.status)
		? Number(request.status)
		: request.status;
	return url.pathname === step.path && request.method === step.method && status === step.status;
}

function sanitizeLighthouseSummary(summary) {
	if (!isObject(summary)) return undefined;
	return {
		mode: String(summary.mode ?? ""),
		device: String(summary.device ?? ""),
		url: safeHttpUrlString(summary.url),
		scores: Array.isArray(summary.scores)
			? summary.scores.map((score) => ({ id: String(score?.id ?? ""), title: String(score?.title ?? ""), score: finiteNumberOrNull(score?.score) }))
			: [],
		audits: isObject(summary.audits) ? {
			passed: integerOrZero(summary.audits.passed),
			failed: integerOrZero(summary.audits.failed),
		} : { passed: 0, failed: 0 },
		timingMs: isObject(summary.timing) ? finiteNumberOrNull(summary.timing.total) : null,
	};
}

function sanitizeHeapSummary(value) {
	const source = isObject(value) ? value : {};
	const aggregate = isObject(source.aggregateStats) ? source.aggregateStats : {};
	return {
		stats: isObject(source.stats) ? numericRecord(source.stats) : {},
		aggregateStats: {
			objectCount: integerOrZero(aggregate.objectCount),
			totalSelfSize: finiteNumberOrNull(aggregate.totalSelfSize),
		},
	};
}

function sanitizePerformanceTrace(value) {
	const text = typeof value?.traceSummary === "string" ? value.traceSummary : "";
	const insightNames = Array.isArray(value?.traceInsights)
		? [...new Set(value.traceInsights
			.map((entry) => String(entry?.insightName ?? ""))
			.filter((name) => /^[A-Za-z0-9._-]{1,80}$/.test(name)))]
		: [];
	const metrics = {};
	const lcp = /(?:^|\n)\s*- LCP:\s*([0-9]+(?:\.[0-9]+)?)\s*ms\b/m.exec(text);
	const cls = /(?:^|\n)\s*- CLS:\s*([0-9]+(?:\.[0-9]+)?)/m.exec(text);
	const cpu = /(?:^|\n)CPU throttling:\s*([0-9]+(?:\.[0-9]+)?)x\b/m.exec(text);
	if (lcp) metrics.lcpMs = Number(lcp[1]);
	if (cls) metrics.cls = Number(cls[1]);
	if (cpu) metrics.cpuThrottlingRate = Number(cpu[1]);
	return { metrics, insightNames };
}

async function assertPageOriginAllowed(executable, sessionId, pageId, allowedOrigins, context, environment) {
	const page = await pageRecord(executable, sessionId, pageId, context, environment);
	const url = new URL(page.url);
	assertAllowedUrl(url, allowedOrigins, "page");
}

async function pageRecord(executable, sessionId, pageId, context, environment) {
	const data = await invokeCliJson(executable, sessionId, "list_pages", [], context, environment);
	const page = Array.isArray(data.pages) ? data.pages.find((entry) => entry?.id === pageId) : undefined;
	if (!page || typeof page.url !== "string") throw new Error(`Chrome DevTools page ${pageId} is no longer available`);
	return page;
}

function selectedPageId(data, targetUrl) {
	if (!Array.isArray(data?.pages)) return undefined;
	const selected = data.pages.find((entry) => entry?.selected && typeof entry?.id === "number");
	if (selected) return selected.id;
	const exact = data.pages.find((entry) => entry?.url === targetUrl && typeof entry?.id === "number");
	return exact?.id;
}

function assertAllowedUrl(url, allowedOrigins, label) {
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !allowedOrigins.includes(url.origin)) {
		throw new Error(`${label} target is outside the exact allowed origins`);
	}
}

async function invokeCliJson(executable, sessionId, command, args, context, environment, timeoutOverride) {
	const timeoutMs = timeoutOverride ?? boundedRemaining(context, 30_000);
	const execution = await runCliProcess(executable, [command, ...args, "--sessionId", sessionId, "--output-format=json"], {
		cwd: context.projectRoot,
		env: environment,
		timeoutMs,
	});
	if (execution.code !== 0) throw new Error(`chrome-devtools ${command} failed: ${safeCliFailure(execution)}`);
	const text = execution.stdout.trim();
	if (!text) return {};
	try {
		const parsed = JSON.parse(text.split(/\r?\n/).filter(Boolean).pop());
		if (Array.isArray(parsed)) {
			const firstText = parsed.find((entry) => entry?.type === "text" && typeof entry.text === "string");
			if (firstText) {
				try { return JSON.parse(firstText.text); } catch { return { message: firstText.text }; }
			}
			return {};
		}
		return isObject(parsed) ? parsed : {};
	} catch {
		throw new Error(`chrome-devtools ${command} returned invalid JSON`);
	}
}

function runCliProcess(executable, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
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
			try { child.kill("SIGKILL"); } catch { /* already exited */ }
			resolve({ code: 124, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut: true, outputTruncated });
		}, Math.max(100, options.timeoutMs));
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
			resolve({ code: code ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut: false, outputTruncated });
		});
	});
}

function resolveChromeDevtoolsExecutable(explicit) {
	if (typeof explicit === "string" && explicit.length > 0) return fs.existsSync(explicit) ? explicit : undefined;
	const names = process.platform === "win32" ? ["chrome-devtools.exe", "chrome-devtools.cmd", "chrome-devtools"] : ["chrome-devtools"];
	const pathValue = process.env.PATH ?? "";
	const extensions = process.platform === "win32"
		? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
		: [""];
	for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
		for (const name of names) {
			const base = path.join(directory, name);
			const candidates = process.platform === "win32" && path.extname(name) === ""
				? [base, ...extensions.map((extension) => `${base}${extension.toLowerCase()}`), ...extensions.map((extension) => `${base}${extension.toUpperCase()}`)]
				: [base];
			for (const candidate of candidates) {
				try {
					if (fs.statSync(candidate).isFile()) return candidate;
				} catch { /* keep searching */ }
			}
		}
	}
	return undefined;
}

function probeCliVersion(executable) {
	const result = spawnSync(executable, ["--version"], {
		encoding: "utf8",
		timeout: 5_000,
		windowsHide: true,
		env: chromeDevtoolsEnvironment(),
	});
	if (result.status !== 0) return undefined;
	const raw = result.stdout.trim().split(/\s+/).pop() ?? "";
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
	if (!match) return undefined;
	return { raw, parts: match.slice(1, 4).map(Number) };
}

function compareVersions(left, right) {
	for (let index = 0; index < 3; index += 1) {
		if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) < (right[index] ?? 0) ? -1 : 1;
	}
	return 0;
}

function chromeDevtoolsEnvironment() {
	const result = {};
	for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "USERPROFILE", "DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"]) {
		if (process.env[key] !== undefined) result[key] = process.env[key];
	}
	return {
		...result,
		CI: "1",
		CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
		CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
	};
}

async function retryUntil(check, timeoutMs, reason) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() <= deadline) {
		try {
			if (await check()) return;
		} catch (error) {
			lastError = error;
		}
		if (Date.now() >= deadline) break;
		await sleep(Math.min(POLL_MS, deadline - Date.now()));
	}
	throw new Error(lastError ? `${reason}: ${safeReason(lastError)}` : reason);
}

function boundedActionTimeout(value, context) {
	const requested = value === undefined ? DEFAULT_ACTION_TIMEOUT_MS : value;
	if (!Number.isInteger(requested) || requested < 100 || requested > MAX_ACTION_TIMEOUT_MS) throw new Error(`timeoutMs must be between 100 and ${MAX_ACTION_TIMEOUT_MS}`);
	return Math.max(100, Math.min(requested, boundedRemaining(context, requested)));
}

function boundedRemaining(context, maximum) {
	return Math.max(100, Math.min(maximum, context.deadline - Date.now()));
}

function safeCliFailure(execution) {
	if (execution.timedOut) return "command timed out";
	return Number.isInteger(execution.code) ? `command exited with code ${execution.code}` : "command failed";
}

function evidenceName(value, index, fallback) {
	const name = value === undefined ? `${fallback}-${index + 1}` : value;
	if (typeof name !== "string" || !SAFE_NAME.test(name) || name === "." || name.includes("..")) throw new Error("evidence name must contain only letters, digits, dot, underscore, or dash without dot segments");
	return name;
}

function numericRecord(value) {
	const result = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "number" && Number.isFinite(entry)) result[key] = entry;
	return result;
}

function safeHttpUrlString(value) {
	if (typeof value !== "string") return "";
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : "";
	} catch { return ""; }
}

function finiteNumberOrNull(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integerOrZero(value) {
	return Number.isInteger(value) && value >= 0 ? value : 0;
}

function blocked(reason, remediation) {
	return { status: "BLOCKED", reason, remediation, assertions: [], observations: [], artifacts: emptyArtifacts() };
}

function emptyArtifacts() {
	return { screenshots: [], videos: [], traces: [], terminalCaptures: [], accessibilitySnapshots: [], observations: [], downloads: [] };
}

function assertKnownFields(value, allowed, label) {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function safeReason(error) {
	return error instanceof Error ? error.message : String(error);
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

