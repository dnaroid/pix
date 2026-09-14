import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER_SOURCE = fileURLToPath(new URL("../drivers/macos/macos-accessibility.swift", import.meta.url));
const MAX_CAPTURE_BYTES = 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 5_000;
const SAFE_ENV = new Set(["CI", "NO_COLOR", "FORCE_COLOR", "LANG", "LC_ALL", "TERM", "TZ"]);
const SHELL_EXECUTABLES = new Set([
	"sh", "bash", "zsh", "fish", "dash", "ksh", "cmd", "cmd.exe", "powershell", "powershell.exe",
	"pwsh", "pwsh.exe", "osascript", "wscript", "wscript.exe", "cscript", "cscript.exe",
]);
const ACTION_FIELDS = {
	waitForWindow: new Set(["action", "timeoutMs"]),
	activateWindow: new Set(["action", "timeoutMs"]),
	snapshotAccessibility: new Set(["action", "name", "depth", "limit", "timeoutMs"]),
	activate: new Set(["action", "selector", "timeoutMs"]),
	setValue: new Set(["action", "selector", "value", "timeoutMs"]),
	inputText: new Set(["action", "text", "timeoutMs"]),
	pressKey: new Set(["action", "key", "modifiers", "timeoutMs"]),
	waitForText: new Set(["action", "text", "timeoutMs"]),
	assertText: new Set(["action", "text", "timeoutMs"]),
	assertState: new Set(["action", "selector", "attribute", "equals", "timeoutMs"]),
	screenshot: new Set(["action", "name", "timeoutMs"]),
	capture: new Set(["action", "name", "depth", "limit", "timeoutMs"]),
};
const MAX_RECORD_DURATION_MS = 30_000;
// Worst case after SIGTERM: the helper may still be completing startup
// (activation plus shareable-content enumeration) before it can finalize the
// MP4; deadline clamping keeps this inside the runner's hard-exit grace.
const RECORD_FINALIZE_GRACE_MS = 15_000;
const RECORD_RUNNER_MARGIN_MS = 5_000;

export async function probeDesktopBackend(context = {}) {
	const supportedCapabilities = ["launch", "attach", "dialogs", "boundedActions", "ownedCleanup"];
	const platform = desktopPlatformContract(process.platform);
	if (!platform.available) return { ...platform, supportedCapabilities };
	if (context.shallow) {
		// The shallow probe never measures Screen Recording permission, so it must
		// not advertise permission-gated capabilities such as windowVideo.
		return {
			available: true,
			platformDriver: "macos-accessibility",
			supportedCapabilities: [...supportedCapabilities, "semanticAccessibility", "accessibilitySnapshot", "windowScreenshot"],
			missingCapabilities: [],
			reason: "macOS has a bundled Accessibility/CGWindow driver",
		};
	}
	try {
		const helper = await ensureMacosHelper(context);
		const doctor = await runOwnedProcess(helper, ["doctor"], {
			cwd: context.projectRoot,
			timeoutMs: remainingTimeout(context, 30_000),
		});
		if (doctor.code !== 0) throw new Error(doctor.stderr || `driver doctor exited ${doctor.code}`);
		const accessibility = /(?:^|\n)accessibility=granted(?:\n|$)/.test(doctor.stdout);
		const screenRecording = /(?:^|\n)screen_recording=granted(?:\n|$)/.test(doctor.stdout);
		// windowVideo has a stricter producer than screenshots: it also needs the
		// ScreenCaptureKit window-stream API (macOS 12.3+), reported by doctor.
		const sck = /(?:^|\n)sck=available(?:\n|$)/.test(doctor.stdout);
		const supported = [...supportedCapabilities];
		const missing = [];
		if (accessibility) supported.push("semanticAccessibility", "accessibilitySnapshot", "semanticActivation", "valueInput", "stateAssertions");
		else missing.push("semanticAccessibility", "accessibilitySnapshot", "semanticActivation", "valueInput", "stateAssertions");
		if (screenRecording) supported.push("windowScreenshot");
		else missing.push("windowScreenshot");
		if (screenRecording && sck) supported.push("windowVideo");
		else missing.push("windowVideo");
		return {
			available: accessibility,
			platformDriver: "macos-accessibility",
			supportedCapabilities: supported,
			missingCapabilities: missing,
			reason: accessibility
				? "macOS Accessibility permission is granted for the bundled semantic driver"
				: "macOS Accessibility permission is missing for the process that runs UI QA",
			remediation: accessibility ? undefined : "grant Accessibility access to the terminal/Pi host in System Settings > Privacy & Security > Accessibility, then rerun",
			details: { accessibility, screenRecording, sck },
		};
	} catch (error) {
		return {
			available: false,
			platformDriver: "macos-accessibility",
			supportedCapabilities,
			missingCapabilities: ["semanticAccessibility", "accessibilitySnapshot", "windowScreenshot", "windowVideo"],
			reason: `macOS accessibility driver is unavailable: ${safeReason(error)}`,
			remediation: "install Apple Command Line Tools (xcrun/swiftc) or use a packaged build of the bundled macOS accessibility helper",
		};
	}
}

export function desktopPlatformContract(platform) {
	if (platform === "darwin") {
		return {
			available: true,
			platformDriver: "macos-accessibility",
			missingCapabilities: [],
			reason: "macOS has a bundled Accessibility/CGWindow driver",
		};
	}
	return {
		available: false,
		platformDriver: platform === "win32" ? "windows-uia-planned" : "linux-at-spi-planned",
		missingCapabilities: ["semanticAccessibility", "accessibilitySnapshot", "windowScreenshot", "windowVideo"],
		reason: `the bundled desktop accessibility driver is not implemented on ${platform}`,
		remediation: platform === "win32"
			? "run on macOS for the bundled driver or add the Windows UI Automation platform driver"
			: "run on macOS for the bundled driver or add the Linux AT-SPI platform driver",
	};
}

export async function runDesktopBackend(context) {
	const probe = await probeDesktopBackend(context);
	if (!probe.available) return blocked(probe.reason, probe.remediation);
	const flow = context.flow;
	const application = validateApplication(flow.target.application, context.projectRoot);
	const steps = validateSteps(flow.steps, probe);
	const helper = await ensureMacosHelper(context);
	const assertions = [];
	const observations = [];
	const artifacts = emptyArtifacts();
	let recorder;
	let launched;
	let selector = application.selector;
	let failure;
	try {
		if (application.launch) {
			launched = launchApplication(application.launch, context);
			selector = application.selector ?? launchedApplicationSelector(launched);
			observations.push({ action: "launch", pid: launched.pid, argv0: application.launch.argv[0] });
		}
		if (!selector) throw new Error("desktop target requires an app selector or a launch contract");
		if (probe.supportedCapabilities.includes("windowVideo")) {
			recorder = await startWindowVideoRecorder({ context, helper, selector, observations });
		} else {
			observations.push({
				action: "windowVideo",
				status: "unavailable",
				reason: "exact-window recording requires macOS 12.3+ and Screen Recording permission",
			});
		}
		for (let index = 0; index < steps.length; index += 1) {
			const step = steps[index];
			context.progress("desktop_action_started", { index, action: step.action });
			try {
				await executeStep({ context, helper, selector, step, index, assertions, observations, artifacts });
				context.progress("desktop_action_finished", { index, action: step.action });
			} catch (error) {
				failure = new Error(`step ${index + 1} (${step.action}) failed: ${safeReason(error)}`);
				break;
			}
		}
		if (!failure) {
			await captureAccessibility({ context, helper, selector, name: "final", artifacts, depth: 10, limit: 100 }).catch((error) => {
				observations.push({ action: "finalCapture", status: "unavailable", reason: safeReason(error) });
			});
		}
	} catch (error) {
		failure = error;
	} finally {
		// Automatic window video is best-effort evidence: recorders run
		// concurrently with the remaining flow and are stopped and finalized
		// here, and their outcome is always a structured observation that can
		// never fail deterministic UI assertions.
		await finalizeWindowRecorder(recorder, artifacts, observations);
		if (failure && selector) {
			await captureAccessibility({ context, helper, selector, name: "failure", artifacts, depth: 10, limit: 100 }).catch(() => {});
			if (probe.details?.screenRecording) {
				await captureScreenshot({ context, helper, selector, name: "failure", artifacts }).catch(() => {});
			}
		}
		if (launched) await terminateOwnedProcessTree(launched);
	}
	return {
		status: failure ? "FAILED" : "PASSED",
		...(failure ? { reason: safeReason(failure) } : {}),
		assertions,
		observations,
		artifacts,
	};
}

export async function createMacosWindowEvidenceController({ context, selector, observations, artifacts }) {
	const helper = await ensureMacosHelper(context);
	const recorder = context.selection?.supportedCapabilities?.includes("windowVideo")
		? await startWindowVideoRecorder({ context, helper, selector, observations })
		: null;
	let finished = false;
	return {
		async capture(name, options = {}) {
			const depth = boundedInt(options.depth, 10, 1, 20, "depth");
			const limit = boundedInt(options.limit, 100, 1, 500, "limit");
			await captureAccessibility({ context, helper, selector, name, artifacts, depth, limit });
			if (probeHasScreenshot(context)) await captureScreenshot({ context, helper, selector, name, artifacts });
		},
		async finish() {
			if (finished) return;
			finished = true;
			await finalizeWindowRecorder(recorder, artifacts, observations);
		},
	};
}

async function finalizeWindowRecorder(recorder, artifacts, observations) {
	if (!recorder) return;
	const outcome = await recorder.stop().catch((error) => ({ name: recorder.name, status: "unavailable", reason: safeReason(error) }));
	if (outcome.status === "recorded") {
		artifacts.videos.push(outcome.artifact);
		observations.push({ action: "windowVideo", name: outcome.name, status: "recorded", durationMs: outcome.durationMs, bytes: outcome.bytes });
	} else {
		observations.push({ action: "windowVideo", name: outcome.name, status: "unavailable", reason: outcome.reason });
	}
}

async function executeStep(options) {
	const { context, helper, selector, step, index, assertions, observations, artifacts } = options;
	const timeoutMs = stepTimeout(step, context);
	switch (step.action) {
		case "waitForWindow":
			await helperCall(helper, ["wait-window", ...selector, "--timeout", String(timeoutMs / 1000)], context, timeoutMs);
			observations.push({ action: step.action, ready: true });
			return;
		case "activateWindow":
			await helperCall(helper, ["focus", ...selector], context, timeoutMs);
			observations.push({ action: step.action, focused: true });
			return;
		case "snapshotAccessibility":
			await captureAccessibility({ context, helper, selector, name: desktopEvidenceName(step.name, index, "snapshot"), artifacts, depth: boundedInt(step.depth, 10, 1, 20, "depth"), limit: boundedInt(step.limit, 100, 1, 500, "limit"), timeoutMs });
			return;
		case "activate":
			await helperCall(helper, ["click", ...selector, ...elementSelectorArgs(step.selector)], context, timeoutMs);
			observations.push({ action: step.action, selector: publicSelector(step.selector) });
			return;
		case "setValue":
			requireBoundedString(step.value, "setValue.value", 4096);
			await helperCall(helper, ["set-value", ...selector, ...elementSelectorArgs(step.selector), "--value", step.value], context, timeoutMs);
			observations.push({ action: step.action, selector: publicSelector(step.selector) });
			return;
		case "inputText":
			requireBoundedString(step.text, "inputText.text", 4096);
			await helperCall(helper, ["type", ...selector, "--text", step.text], context, timeoutMs);
			observations.push({ action: step.action, characters: [...step.text].length });
			return;
		case "pressKey": {
			const key = requireBoundedString(step.key, "pressKey.key", 32);
			const args = ["key", ...selector, "--key", key];
			if (step.modifiers !== undefined) {
				if (!Array.isArray(step.modifiers) || step.modifiers.some((value) => !["cmd", "shift", "ctrl", "opt", "fn"].includes(value))) throw new Error("pressKey.modifiers contains an unsupported modifier");
				args.push("--modifiers", step.modifiers.join(","));
			}
			await helperCall(helper, args, context, timeoutMs);
			observations.push({ action: step.action, key, modifiers: step.modifiers ?? [] });
			return;
		}
		case "waitForText": {
			const text = requireBoundedString(step.text, "waitForText.text", 4096);
			await waitFor(async () => (await inspect(helper, selector, context, timeoutMs)).includes(text), timeoutMs, `text ${JSON.stringify(text)} did not appear`);
			observations.push({ action: step.action, text });
			return;
		}
		case "assertText": {
			const text = requireBoundedString(step.text, "assertText.text", 4096);
			const snapshot = await inspect(helper, selector, context, timeoutMs);
			const passed = snapshot.includes(text);
			assertions.push({ action: step.action, expected: { visibleText: text }, passed });
			if (!passed) throw new Error(`visible accessibility text does not contain ${JSON.stringify(text)}`);
			return;
		}
		case "assertState": {
			const attribute = requireBoundedString(step.attribute, "assertState.attribute", 32);
			if (!["title", "description", "identifier", "help", "value", "enabled", "focused", "selected"].includes(attribute)) throw new Error(`unsupported accessibility state: ${attribute}`);
			const described = await describe(helper, selector, step.selector, context, timeoutMs);
			const actual = described.attributes?.[attribute];
			const expected = String(step.equals);
			const passed = actual === expected;
			assertions.push({ action: step.action, selector: publicSelector(step.selector), attribute, expected, actual, passed });
			if (!passed) throw new Error(`expected ${attribute}=${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
			return;
		}
		case "screenshot":
			await captureScreenshot({ context, helper, selector, name: desktopEvidenceName(step.name, index, "screenshot"), artifacts, timeoutMs });
			return;
		case "capture": {
			const name = desktopEvidenceName(step.name, index, "capture");
			await captureAccessibility({ context, helper, selector, name, artifacts, depth: boundedInt(step.depth, 10, 1, 20, "depth"), limit: boundedInt(step.limit, 100, 1, 500, "limit"), timeoutMs });
			if (probeHasScreenshot(context)) await captureScreenshot({ context, helper, selector, name, artifacts, timeoutMs });
			return;
		}
		default:
			throw new Error(`unsupported desktop action: ${step.action}`);
	}
}

function validateApplication(value, projectRoot) {
	if (!isObject(value)) throw new Error("target.application must be an object");
	const allowed = new Set(["pid", "name", "bundleId", "launch"]);
	assertKnownFields(value, allowed, "target.application");
	const selectors = [];
	if (value.pid !== undefined) {
		if (!Number.isInteger(value.pid) || value.pid <= 0) throw new Error("target.application.pid must be a positive integer");
		selectors.push(["--pid", String(value.pid)]);
	}
	if (value.name !== undefined) selectors.push(["--app", requireBoundedString(value.name, "target.application.name", 200)]);
	if (value.bundleId !== undefined) selectors.push(["--bundle-id", requireBoundedString(value.bundleId, "target.application.bundleId", 200)]);
	if (selectors.length > 1) throw new Error("target.application must use only one of pid, name, or bundleId");
	const launch = value.launch === undefined ? undefined : validateLaunch(value.launch, projectRoot);
	if (launch && selectors.length > 0) throw new Error("target.application.launch cannot be combined with pid, name, or bundleId");
	if (!launch && selectors.length !== 1) throw new Error("target.application requires one selector when launch is absent");
	return { selector: selectors[0], launch };
}

function validateLaunch(value, projectRoot) {
	if (!isObject(value)) throw new Error("application.launch must be an object");
	assertKnownFields(value, new Set(["argv", "cwd", "env"]), "application.launch");
	if (!Array.isArray(value.argv) || value.argv.length < 1 || value.argv.length > 64) throw new Error("application.launch.argv must contain 1..64 strings");
	const argv = value.argv.map((part, index) => requireBoundedString(part, `application.launch.argv[${index}]`, 4096));
	if (SHELL_EXECUTABLES.has(path.basename(argv[0]).toLowerCase())) throw new Error("application launch cannot invoke a shell or scripting host");
	const cwd = resolveProjectDirectory(projectRoot, value.cwd ?? ".");
	validateLaunchContract(argv, cwd, projectRoot);
	return { argv, cwd, env: validateEnv(value.env) };
}

function validateLaunchContract(argv, cwd, projectRoot) {
	const executable = argv[0];
	const base = path.basename(executable).toLowerCase();
	if (path.isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
		if (!isProjectFile(projectRoot, path.resolve(cwd, executable), true)) throw new Error("desktop executable paths must resolve to a non-symlink executable inside the project");
		return;
	}
	if (["node", "node.exe", "python", "python3", "python.exe", "ruby", "perl", "deno", "deno.exe"].includes(base)) {
		const scriptIndex = base.startsWith("deno") ? (argv[1] === "run" ? 2 : -1) : 1;
		if (scriptIndex < 1 || !argv[scriptIndex] || argv[scriptIndex].startsWith("-") || !isProjectFile(projectRoot, path.resolve(cwd, argv[scriptIndex]), false)) {
			throw new Error(`${base} launch requires an explicit project-local script file`);
		}
		return;
	}
	if (base === "bun" || base === "bun.exe") {
		if (argv[1] === "run" && /^[A-Za-z0-9:_-]+$/.test(argv[2] ?? "")) return;
		if (isProjectFile(projectRoot, path.resolve(cwd, argv[1] ?? ""), false)) return;
		throw new Error("bun launch requires a project-local script or `bun run <script>`");
	}
	if (["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"].includes(base)) {
		const offset = argv[1] === "run" ? 2 : 1;
		if ((argv[1] === "run" || argv[1] === "start" || argv[1] === "test") && /^[A-Za-z0-9:_-]+$/.test(argv[offset] ?? "")) return;
		throw new Error(`${base} launch must use a bounded run, start, or test script`);
	}
	if (["cargo", "go", "dotnet"].includes(base) && argv[1] === "run") return;
	throw new Error("desktop launch executable must be project-local or a bounded package/runtime launch contract");
}

function isProjectFile(projectRoot, value, requireExecutable) {
	if (!isInside(projectRoot, value) || !fs.existsSync(value)) return false;
	let current = projectRoot;
	for (const part of path.relative(projectRoot, value).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		if (fs.lstatSync(current).isSymbolicLink()) return false;
	}
	const stat = fs.statSync(value);
	return stat.isFile() && (!requireExecutable || process.platform === "win32" || (stat.mode & 0o111) !== 0);
}

function validateEnv(value) {
	if (value === undefined) return {};
	if (!isObject(value)) throw new Error("launch.env must be an object");
	const result = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!SAFE_ENV.has(key) && !key.startsWith("PI_UI_QA_")) throw new Error(`launch.env key is not allowed: ${key}`);
		result[key] = requireBoundedString(raw, `launch.env.${key}`, 4096);
	}
	return result;
}

function validateSteps(steps, probe) {
	if (!Array.isArray(steps) || steps.length < 1 || steps.length > 100) throw new Error("desktop flow requires 1..100 steps");
	return steps.map((step, index) => {
		if (!isObject(step) || typeof step.action !== "string" || !ACTION_FIELDS[step.action]) throw new Error(`desktop step ${index + 1} has an unsupported action`);
		assertKnownFields(step, ACTION_FIELDS[step.action], `desktop step ${index + 1}`);
		return validateDesktopStepCapabilities(step, probe.supportedCapabilities ?? []);
	});
}

// Exported for focused unit tests: capability gating must be honest about what
// the probed producer actually supports on this host.
export function validateDesktopStepCapabilities(step, supportedCapabilities) {
	if ((step.action === "screenshot" || step.action === "capture") && !supportedCapabilities.includes("windowScreenshot")) {
		throw new Error("desktop flow requires windowScreenshot, but macOS Screen Recording permission is missing");
	}
	return step;
}

function launchApplication(launch, context) {
	const [file, ...args] = launch.argv;
	const logPath = path.join(context.evidenceDir, "application.log");
	const child = spawn(file, args, {
		cwd: launch.cwd,
		env: launchEnvironment(launch.env),
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	const stream = fs.createWriteStream(logPath, { flags: "wx", mode: 0o600 });
	let bytes = 0;
	const write = (chunk) => {
		if (bytes >= MAX_CAPTURE_BYTES) return;
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const kept = buffer.subarray(0, MAX_CAPTURE_BYTES - bytes);
		bytes += kept.length;
		stream.write(kept);
	};
	child.stdout?.on("data", write);
	child.stderr?.on("data", write);
	child.once("error", (error) => write(`\nlaunch error: ${safeReason(error)}\n`));
	child.once("close", () => stream.end());
	if (!child.pid) throw new Error("desktop launch did not return a process id");
	return child;
}

// A detached POSIX launch is a session/process-group leader. Package managers
// commonly exit after handing the actual GUI process to a descendant, so PID
// lookup of that wrapper is not a reliable application selector. The group is
// both the launch ownership boundary and the selector boundary for macOS.
// Windows has no equivalent process-group lookup in its planned driver yet.
export function launchedApplicationSelector(launched, platform = process.platform) {
	if (!launched?.pid) throw new Error("desktop launch did not return a process id");
	return platform === "win32" ? ["--pid", String(launched.pid)] : ["--pgid", String(launched.pid)];
}

function launchEnvironment(extra) {
	const result = {};
	for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "USERPROFILE"]) {
		if (process.env[key] !== undefined) result[key] = process.env[key];
	}
	return { ...result, ...extra, PI_UI_QA: "1" };
}

async function ensureMacosHelper(context) {
	if (process.platform !== "darwin") throw new Error("macOS accessibility helper requested on another platform");
	if (!fs.existsSync(DRIVER_SOURCE)) throw new Error("bundled macOS accessibility helper source is missing");
	const helpersDir = path.join(context.workspaceDir, "helpers");
	createPrivateDirectory(context.workspaceDir, helpersDir);
	const digest = createHash("sha256").update(fs.readFileSync(DRIVER_SOURCE)).digest("hex").slice(0, 16);
	const binary = path.join(helpersDir, `macos-accessibility-${digest}`);
	if (fs.existsSync(binary)) {
		const stat = fs.lstatSync(binary);
		if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("macOS helper cache entry is not a regular file");
		return binary;
	}
	const temporary = `${binary}.${process.pid}.tmp`;
	const result = await runOwnedProcess("xcrun", ["swiftc", "-O", DRIVER_SOURCE, "-o", temporary], {
		cwd: context.workspaceDir,
		timeoutMs: remainingTimeout(context, 60_000),
	});
	if (result.code !== 0) throw new Error(result.stderr || `swiftc exited ${result.code}`);
	fs.chmodSync(temporary, 0o700);
	fs.renameSync(temporary, binary);
	return binary;
}

async function helperCall(helper, args, context, timeoutMs) {
	const result = await runOwnedProcess(helper, args, { cwd: context.projectRoot, timeoutMs: Math.min(timeoutMs, remainingTimeout(context, timeoutMs)) });
	if (result.code !== 0) throw new Error(result.stderr || `macOS accessibility helper exited ${result.code}`);
	return result.stdout.trim();
}

async function inspect(helper, selector, context, timeoutMs, depth = 12, limit = 300) {
	return helperCall(helper, ["inspect", ...selector, "--depth", String(depth), "--limit", String(limit), "--all"], context, timeoutMs);
}

async function describe(helper, selector, elementSelector, context, timeoutMs) {
	const output = await helperCall(helper, ["describe", ...selector, ...elementSelectorArgs(elementSelector)], context, timeoutMs);
	try { return JSON.parse(output); } catch { throw new Error("macOS accessibility driver returned an invalid semantic record"); }
}

async function captureAccessibility({ context, helper, selector, name, artifacts, depth, limit, timeoutMs = 15_000 }) {
	const output = await inspect(helper, selector, context, timeoutMs, depth, limit);
	const filename = `${name}.accessibility.txt`;
	writePrivate(path.join(context.evidenceDir, filename), `${output}\n`);
	artifacts.accessibilitySnapshots.push(context.artifact(filename, "accessibility snapshot"));
}

async function captureScreenshot({ context, helper, selector, name, artifacts, timeoutMs = 15_000 }) {
	const filename = `${name}.png`;
	const target = path.join(context.evidenceDir, filename);
	await helperCall(helper, ["screenshot", ...selector, "--out", target], context, timeoutMs);
	if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error("desktop screenshot was not created");
	artifacts.screenshots.push(context.artifact(filename, "screenshot"));
}

// Starts the helper's ScreenCaptureKit exact-window producer. The recorder only
// starts after the selector resolves and the target window is ready, records
// concurrently with the remaining flow, enforces a helper-side 30s hard cap,
// and is stopped/finalized by the backend's finally block.
async function startWindowVideoRecorder({ context, helper, selector, observations }) {
	const name = "window";
	try {
		const remaining = Math.max(0, context.deadline - Date.now());
		const durationMs = Math.min(MAX_RECORD_DURATION_MS, remaining - RECORD_RUNNER_MARGIN_MS);
		if (durationMs < 500) {
			observations.push({ action: "windowVideo", name, status: "unavailable", reason: "not enough runner time remains to record window video" });
			return null;
		}
		await helperCall(helper, ["wait-window", ...selector, "--timeout", "10"], context, 15_000);
		const filename = `${name}.mp4`;
		const target = path.join(context.evidenceDir, filename);
		const child = spawn(helper, ["record-window", ...selector, "--out", target, "--duration", String(durationMs / 1000)], {
			cwd: context.projectRoot,
			env: launchEnvironment({}),
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		if (!child.pid) throw new Error("window recorder did not return a process id");
		const recorder = windowVideoRecorderHandle({ context, child, name, durationMs, filename, target });
		if (!await recorder.ready(Math.min(15_000, remainingTimeout(context, 15_000)))) {
			const outcome = await recorder.stop();
			cleanupPartialVideo(target);
			observations.push({ action: "windowVideo", name, status: "unavailable", reason: outcome.reason ?? "window recorder exited before capture started" });
			return null;
		}
		observations.push({ action: "windowVideo", name, status: "started", durationMs, pid: child.pid });
		return recorder;
	} catch (error) {
		observations.push({ action: "windowVideo", name, status: "unavailable", reason: safeReason(error) });
		return null;
	}
}

function windowVideoRecorderHandle({ context, child, name, durationMs, filename, target }) {
	let stdout = Buffer.alloc(0);
	let stderr = Buffer.alloc(0);
	let exitCode = null;
	let ready = false;
	let startedAt;
	let resolveReady;
	const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
	const exited = new Promise((resolve) => {
		child.stdout?.on("data", (chunk) => {
			stdout = appendBounded(stdout, chunk);
			if (!ready && stdout.toString("utf8").includes("recording-started\n")) {
				ready = true;
				startedAt = Date.now();
				resolveReady(true);
			}
		});
		child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
		child.once("error", (error) => {
			exitCode = 1;
			stderr = appendBounded(stderr, Buffer.from(safeReason(error)));
			resolveReady(false);
			resolve();
		});
		child.once("close", (code) => { exitCode = code ?? 1; resolveReady(false); resolve(); });
	});
	return {
		name,
		durationMs,
		async ready(timeoutMs) {
			return Promise.race([readyPromise, sleep(timeoutMs).then(() => false)]);
		},
		// Signals the helper (SIGTERM finalizes and publishes the MP4), waits a
		// bounded grace, then escalates to SIGKILL and cleans partial files.
		// Never throws: every outcome is structured.
		async stop() {
			const graceMs = Math.max(1_000, Math.min(RECORD_FINALIZE_GRACE_MS, context.deadline - Date.now()));
			if (exitCode === null) {
				killOwnedPid(child.pid, "SIGTERM");
				const finished = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
				if (!finished) {
					killOwnedPid(child.pid, "SIGKILL");
					await Promise.race([exited, sleep(2_000)]);
					cleanupPartialVideo(target);
					return { name, status: "unavailable", reason: "the window recorder did not finalize within its grace period" };
				}
			}
			if (exitCode !== 0) {
				cleanupPartialVideo(target);
				const reason = stderr.toString("utf8").trim();
				return { name, status: "unavailable", reason: reason || `window recorder exited with code ${exitCode}` };
			}
			const stat = fs.existsSync(target) ? fs.statSync(target) : null;
			if (!stat?.isFile() || stat.size < 1) {
				cleanupPartialVideo(target);
				return { name, status: "unavailable", reason: stdout.toString("utf8").trim() || "the window recorder produced no video file" };
			}
			if (process.platform !== "win32") fs.chmodSync(target, 0o600);
			const recordedDurationMs = startedAt === undefined ? 0 : Math.min(durationMs, Math.max(0, Date.now() - startedAt));
			return {
				name,
				status: "recorded",
				durationMs: recordedDurationMs,
				bytes: stat.size,
				artifact: { ...context.artifact(filename, "window video"), format: "mp4", durationMs: recordedDurationMs },
			};
		},
	};
}

function appendBounded(current, chunk) {
	return Buffer.concat([current, Buffer.from(chunk)]).subarray(0, MAX_CAPTURE_BYTES);
}

function cleanupPartialVideo(target) {
	try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
	try {
		const prefix = `${path.basename(target)}.`;
		for (const entry of fs.readdirSync(path.dirname(target))) {
			if (entry.startsWith(prefix) && entry.endsWith(".tmp")) fs.rmSync(path.join(path.dirname(target), entry), { force: true });
		}
	} catch { /* best effort */ }
}

function runOwnedProcess(file, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, {
			cwd: options.cwd,
			env: launchEnvironment({}),
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let settled = false;
		const append = (current, chunk) => Buffer.concat([current, Buffer.from(chunk)]).subarray(0, MAX_CAPTURE_BYTES);
		child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
		child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			killOwnedPid(child.pid, "SIGKILL");
			reject(new Error(`desktop driver stage timed out after ${options.timeoutMs} ms`));
		}, Math.max(1, options.timeoutMs));
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
			resolve({ code: code ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8").trim() });
		});
	});
}

export async function terminateOwnedProcessTree(child) {
	if (!child.pid) return;
	if (process.platform === "win32") {
		killOwnedPid(child.pid, "SIGTERM");
		await Promise.race([
			new Promise((resolve) => child.once("close", resolve)),
			new Promise((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS)),
		]);
		if (isPidAlive(child.pid)) killOwnedPid(child.pid, "SIGKILL");
		return;
	}

	// Do not use the wrapper's liveness as the cleanup condition: npm/pnpm and
	// similar launchers can exit while their GUI child remains in this owned
	// group. SIGTERM gives the group a bounded graceful shutdown; SIGKILL is
	// sent to the same group if any member survives the grace period.
	const pgid = child.pid;
	killOwnedProcessGroup(pgid, "SIGTERM");
	const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
	while (isOwnedProcessGroupAlive(pgid) && Date.now() < deadline) await sleep(Math.min(50, deadline - Date.now()));
	if (isOwnedProcessGroupAlive(pgid)) killOwnedProcessGroup(pgid, "SIGKILL");
}

function killOwnedProcessGroup(pgid, signal) {
	if (!Number.isInteger(pgid) || pgid <= 0) return;
	try { process.kill(-pgid, signal); } catch { /* group already exited */ }
}

function isOwnedProcessGroupAlive(pgid) {
	if (!Number.isInteger(pgid) || pgid <= 0) return false;
	try { process.kill(-pgid, 0); return true; } catch { return false; }
}

function killOwnedPid(pid, signal) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform !== "win32") {
		try { process.kill(-pid, signal); return; } catch { /* process may not be a group leader */ }
	}
	try { process.kill(pid, signal); } catch { /* already exited */ }
}

function isPidAlive(pid) {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function elementSelectorArgs(value) {
	if (!isObject(value)) throw new Error("semantic action requires selector");
	assertKnownFields(value, new Set(["path", "name", "role", "occurrence"]), "selector");
	const args = [];
	if (value.path !== undefined) args.push("--path", requireBoundedString(value.path, "selector.path", 200));
	else if (value.name !== undefined) args.push("--match", requireBoundedString(value.name, "selector.name", 500));
	else throw new Error("selector requires path or name");
	if (value.role !== undefined) args.push("--role", requireBoundedString(value.role, "selector.role", 100));
	if (value.occurrence !== undefined) {
		if (!Number.isInteger(value.occurrence) || value.occurrence < 1 || value.occurrence > 100) throw new Error("selector.occurrence must be 1..100");
		args.push("--occurrence", String(value.occurrence));
	}
	return args;
}

function publicSelector(value) {
	return isObject(value) ? value : {};
}

function resolveProjectDirectory(projectRoot, value) {
	const resolved = path.resolve(projectRoot, requireBoundedString(value, "launch.cwd", 4096));
	if (!isInside(projectRoot, resolved)) throw new Error("launch.cwd must stay inside the project");
	if (!fs.existsSync(resolved)) throw new Error("launch.cwd does not exist");
	let current = projectRoot;
	for (const part of path.relative(projectRoot, resolved).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		if (fs.lstatSync(current).isSymbolicLink()) throw new Error("launch.cwd must not contain symlinks");
	}
	const real = fs.realpathSync(resolved);
	if (!isInside(projectRoot, real) || !fs.statSync(real).isDirectory()) throw new Error("launch.cwd must be a project-local directory");
	return real;
}

function createPrivateDirectory(root, target) {
	if (!isInside(root, target)) throw new Error("helper cache must stay inside the UI QA workspace");
	if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(target);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("helper cache must be a real directory");
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("helper cache must use mode 0700");
}

function stepTimeout(step, context) {
	const value = step.timeoutMs ?? Math.min(15_000, context.stageTimeoutMs);
	if (!Number.isFinite(value) || value < 50 || value > 30_000) throw new Error("step timeoutMs must be between 50 and 30000");
	return Math.min(Math.round(value), remainingTimeout(context, Math.round(value)));
}

function remainingTimeout(context, cap) {
	const remaining = context.deadline - Date.now();
	if (remaining <= 0) throw new Error("UI QA runner deadline expired");
	return Math.max(1, Math.min(cap, remaining));
}

async function waitFor(check, timeoutMs, reason) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(100);
	}
	throw new Error(reason);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

function boundedInt(value, fallback, min, max, name) {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
	return value;
}

function captureName(value, fallback) {
	if (value === undefined) return fallback;
	const name = requireBoundedString(value, "capture name", 80);
	if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("capture name must contain only letters, digits, underscore, or dash");
	return name;
}

export function desktopEvidenceName(value, zeroBasedStepIndex, fallback) {
	if (!Number.isInteger(zeroBasedStepIndex) || zeroBasedStepIndex < 0) throw new Error("step index must be a non-negative integer");
	return captureName(value, `${fallback}-${zeroBasedStepIndex + 1}`);
}

function assertKnownFields(value, allowed, label) {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
}

function requireBoundedString(value, label, maxLength) {
	if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value.includes("\0")) throw new Error(`${label} must be a non-empty string no longer than ${maxLength}`);
	return value;
}

function writePrivate(file, content) {
	fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function probeHasScreenshot(context) {
	return context.selection?.supportedCapabilities?.includes("windowScreenshot") === true;
}

function emptyArtifacts() {
	return { screenshots: [], videos: [], traces: [], terminalCaptures: [], accessibilitySnapshots: [], observations: [], downloads: [] };
}

function blocked(reason, remediation) {
	return { status: "BLOCKED", reason, remediation, assertions: [], observations: [], artifacts: emptyArtifacts() };
}

function isInside(root, target) {
	const relative = path.relative(root, target);
	return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeReason(error) {
	return error instanceof Error ? error.message : String(error);
}
