#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { probeBrowserBackend, runBrowserBackend } from "../backends/browser.mjs";
import { probeDesktopBackend, runDesktopBackend } from "../backends/desktop.mjs";
import { probeTuiBackend, runTuiBackend } from "../backends/tui.mjs";

const AGENT_DIR_ENV = "PI_SUBAGENT_AGENT_DIR";
const WORKSPACE_RELATIVE = "ui-qa";
// Guides are a fixed allowlist of bundled documents, never model-provided
// paths. `guide` is read-only: it touches only these files and requires no
// agent workspace, so it stays usable from any cwd.
const GUIDES_DIR_RELATIVE_URL = "../guides/";
const GUIDE_FILES = {
	browser: "browser.md",
	tui: "tui.md",
	desktop: "desktop.md",
};
const GUIDE_AUTH_FILE = "browser-auth.md";
const MAX_GUIDE_BYTES = 256 * 1024;
const FLOW_RELATIVE = "flows";
const EVIDENCE_RELATIVE = "evidence";
// Preserve the trusted browser runner's bounded in-memory upload contract.
// Native/TUI schemas remain small, while browser flows may contain base64 file
// payloads up to the legacy runner's 16 MiB flow limit.
const MAX_FLOW_BYTES = 16 * 1024 * 1024;
const MAX_STEPS = 100;
const DEFAULT_BLOCKED_REMEDIATION = "report this blocker to the parent agent; no safe automatic remediation is defined";
const DEFAULT_RUNNER_TIMEOUT_MS = 90_000;
const MAX_RUNNER_TIMEOUT_MS = 100_000;
// Backends may spend up to five seconds escalating owned children from SIGTERM
// to SIGKILL. The process-level hard exit must be strictly later or it can win
// that cleanup race and orphan an app, PTY, or trusted browser runner.
const HARD_EXIT_GRACE_MS = 10_000;
const PROGRESS_MAX_BYTES = 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

process.umask(0o077);

class UiQaError extends Error {
	constructor(status, reason, exitCode = 1, details = {}) {
		super(reason);
		this.status = status;
		this.reason = reason;
		this.exitCode = exitCode;
		this.details = details;
	}
}

main().catch((error) => {
	const failure = error instanceof UiQaError
		? error
		: new UiQaError("FAILED", safeReason(error));
	writeStatus(normalizeResult({
		status: failure.status,
		reason: failure.reason,
		...failure.details,
	}));
	process.exit(failure.exitCode);
});

async function main() {
	const [command = "probe", ...rawArgs] = process.argv.slice(2);
	if (command !== "guide" && command !== "probe" && command !== "run") {
		throw new UiQaError("FAILED", `unknown command: ${command}`);
	}
	if (command === "guide") return runGuideCommand(rawArgs);
	const args = parseArgs(rawArgs, command);
	const projectRoot = fs.realpathSync(process.cwd());
	const agentDir = resolveAgentDirectory(projectRoot, process.env[AGENT_DIR_ENV]);
	const workspaceDir = path.join(agentDir, WORKSPACE_RELATIVE);
	const flowPath = resolveFlowPath(workspaceDir, args.flow);
	const flow = readFlow(flowPath, command === "run");
	const runnerTimeoutMs = parseRunnerTimeout(args.runnerTimeoutMs);
	const deadline = Date.now() + runnerTimeoutMs;
	const progress = createProgress(workspaceDir);
	const common = {
		flow,
		projectRoot,
		agentDir,
		workspaceDir,
		deadline,
		stageTimeoutMs: Math.min(30_000, runnerTimeoutMs),
		progress,
	};
	progress("runner_started", { command, timeoutMs: runnerTimeoutMs });

	const hardTimer = setTimeout(() => {
		writeStatus(normalizeResult({
			status: "FAILED",
			reason: `UI QA runner exceeded ${runnerTimeoutMs + HARD_EXIT_GRACE_MS} ms`,
			timedOut: true,
		}));
		process.exit(124);
	}, runnerTimeoutMs + HARD_EXIT_GRACE_MS);
	hardTimer.unref?.();

	try {
		const selection = await selectBackend(common);
		progress("backend_selected", {
			targetKind: selection.detectedTargetKind,
			backend: selection.selectedBackend,
		});
		if (command === "probe") {
			const status = selection.available ? "AVAILABLE" : "BLOCKED";
			writeStatus(normalizeResult({
				status,
				selection: publicSelection(selection),
				...(selection.available ? {} : {
					reason: selection.reason,
					remediation: selection.remediation,
				}),
			}));
			if (!selection.available) process.exitCode = 2;
			return;
		}
		if (!selection.available) {
			throw new UiQaError("BLOCKED", selection.reason ?? "selected UI backend is unavailable", 2, {
				selection: publicSelection(selection),
				remediation: selection.remediation,
			});
		}

		const runId = safeRunId(args.runId ?? timestamp());
		const evidenceDir = path.join(workspaceDir, EVIDENCE_RELATIVE, runId);
		createExclusivePrivateDirectory(workspaceDir, evidenceDir);
		const artifact = (value, kind) => artifactRecord(evidenceDir, value, kind);
		const context = {
			...common,
			runId,
			evidenceDir,
			artifact,
			// The selected backend's probed capability record, so backends can
			// gate producer-dependent steps (screenshot/video) honestly instead
			// of assuming capabilities the host never granted.
			selection: publicSelection(selection),
			browserRunnerPath: fileURLToPath(new URL("../browser/scripts/browser-qa-runner.mjs", import.meta.url)),
		};
		const backendResult = await runSelectedBackend(selection.selectedBackend, context);
		const deadlineExpired = Date.now() >= deadline;
		const result = normalizeResult({
			...backendResult,
			...(deadlineExpired ? { status: "FAILED", timedOut: true, reason: backendResult.reason ?? "UI QA runner deadline expired" } : {}),
			selection: publicSelection(selection),
			evidenceDir: relativePath(projectRoot, evidenceDir),
		});
		writeJsonPrivate(path.join(evidenceDir, "result.json"), result);
		writeStatus(result);
		if (result.status === "BLOCKED") process.exitCode = 2;
		else if (result.status !== "PASSED") process.exitCode = result.timedOut ? 124 : 1;
	} finally {
		clearTimeout(hardTimer);
		progress("runner_finished");
	}
}

/**
 * Read-only progressive-disclosure loader. Prints exactly one allowlisted
 * bundled guide to stdout; anything else (unknown backend/topic/option, extra
 * or positional arguments, traversal) fails closed. Deliberately independent
 * of PI_SUBAGENT_AGENT_DIR and the project cwd.
 */
function runGuideCommand(rawArgs) {
	const options = parseGuideArgs(rawArgs);
	const fileName = options.topic === "auth" ? GUIDE_AUTH_FILE : GUIDE_FILES[options.backend];
	const guidesDir = fileURLToPath(new URL(GUIDES_DIR_RELATIVE_URL, import.meta.url));
	const guidePath = path.join(guidesDir, fileName);
	// The allowlisted name cannot traverse, but keep the containment, symlink,
	// regular-file, and bounded-size checks for defense in depth.
	assertInside(guidesDir, guidePath, "UI QA guide");
	assertNoSymlinkComponents(guidesDir, guidePath, "UI QA guide");
	const stat = fs.statSync(guidePath);
	if (!stat.isFile()) throw new UiQaError("FAILED", "UI QA guide must be a regular file");
	if (stat.size > MAX_GUIDE_BYTES) {
		throw new UiQaError("FAILED", `UI QA guide must be no larger than ${MAX_GUIDE_BYTES} bytes`);
	}
	process.stdout.write(fs.readFileSync(guidePath, "utf8"));
}

function parseGuideArgs(values) {
	const options = {};
	for (let index = 0; index < values.length; index += 2) {
		const flag = values[index];
		const value = values[index + 1];
		if (!flag?.startsWith("--") || value === undefined) throw new UiQaError("FAILED", `invalid guide argument: ${flag ?? "(missing)"}`);
		const key = flag.slice(2);
		if (key !== "backend" && key !== "topic") throw new UiQaError("FAILED", `unknown guide option: ${flag}`);
		if (options[key] !== undefined) throw new UiQaError("FAILED", `duplicate guide option: ${flag}`);
		options[key] = value;
	}
	if (!options.backend) throw new UiQaError("FAILED", "--backend is required for guide");
	if (!Object.hasOwn(GUIDE_FILES, options.backend)) {
		throw new UiQaError("FAILED", `unknown guide backend: ${options.backend}`);
	}
	if (options.topic !== undefined) {
		if (options.topic !== "auth") throw new UiQaError("FAILED", `unknown guide topic: ${options.topic}`);
		if (options.backend !== "browser") throw new UiQaError("FAILED", "--topic auth is available only for --backend browser");
	}
	return options;
}

async function selectBackend(context) {
	const detectedTargetKind = detectTargetKind(context.flow.target);
	const probes = {
		browser: await probeBrowserBackend({ ...context, shallow: detectedTargetKind !== "browser" }),
		tui: await probeTuiBackend({ ...context, shallow: detectedTargetKind !== "tui" }),
		desktop: await probeDesktopBackend({ ...context, shallow: detectedTargetKind !== "desktop" }),
	};
	const selected = probes[detectedTargetKind];
	if (!selected || typeof selected !== "object") {
		throw new UiQaError("FAILED", `backend probe returned no result for ${detectedTargetKind}`);
	}
	const candidateBackends = ["browser", "tui", "desktop"].map((backend) => ({
		backend,
		eligible: backend === detectedTargetKind,
		available: Boolean(probes[backend]?.available),
		supportedCapabilities: stringArray(probes[backend]?.supportedCapabilities),
		missingCapabilities: stringArray(probes[backend]?.missingCapabilities),
		...(probes[backend]?.platformDriver ? { platformDriver: probes[backend].platformDriver } : {}),
		why: backend === detectedTargetKind
			? (probes[backend]?.reason ?? `target descriptor matches the ${backend} backend`)
			: `target descriptor does not match the ${backend} backend`,
	}));
	return {
		detectedTargetKind,
		candidateBackends,
		selectedBackend: detectedTargetKind,
		platformDriver: selected.platformDriver,
		supportedCapabilities: stringArray(selected.supportedCapabilities),
		missingCapabilities: stringArray(selected.missingCapabilities),
		whySelected: selected.reason ?? `target descriptor matches the ${detectedTargetKind} backend`,
		available: Boolean(selected.available),
		reason: selected.available ? undefined : selected.reason,
		remediation: selected.remediation,
	};
}

function publicSelection(selection) {
	return {
		detectedTargetKind: selection.detectedTargetKind,
		candidateBackends: selection.candidateBackends,
		selectedBackend: selection.selectedBackend,
		...(selection.platformDriver ? { platformDriver: selection.platformDriver } : {}),
		supportedCapabilities: selection.supportedCapabilities,
		missingCapabilities: selection.missingCapabilities,
		whySelected: selection.whySelected,
	};
}

async function runSelectedBackend(backend, context) {
	if (backend === "browser") return runBrowserBackend(context);
	if (backend === "tui") return runTuiBackend(context);
	if (backend === "desktop") return runDesktopBackend(context);
	throw new UiQaError("FAILED", `unsupported backend: ${backend}`);
}

function detectTargetKind(target) {
	if (!isObject(target)) throw new UiQaError("FAILED", "flow.target must be an object");
	const matches = [];
	if (typeof target.url === "string" || typeof target.baseUrl === "string") matches.push("browser");
	if (isObject(target.command) && Array.isArray(target.command.argv)) matches.push("tui");
	if (isObject(target.application)) matches.push("desktop");
	if (matches.length !== 1) {
		throw new UiQaError("BLOCKED", "target discovery requires exactly one of target.url/baseUrl, target.command.argv, or target.application", 2);
	}
	if (target.kind !== undefined && target.kind !== "auto" && target.kind !== matches[0]) {
		throw new UiQaError("FAILED", `target.kind ${JSON.stringify(target.kind)} contradicts detected target kind ${matches[0]}`);
	}
	return matches[0];
}

function parseArgs(values, command) {
	const result = {};
	for (let index = 0; index < values.length; index += 2) {
		const flag = values[index];
		const value = values[index + 1];
		if (!flag?.startsWith("--") || value === undefined) throw new UiQaError("FAILED", `invalid argument: ${flag ?? "(missing)"}`);
		const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
		const allowed = command === "run" ? ["flow", "runId", "runnerTimeoutMs"] : ["flow", "runnerTimeoutMs"];
		if (!allowed.includes(key)) throw new UiQaError("FAILED", `unknown option: ${flag}`);
		if (result[key] !== undefined) throw new UiQaError("FAILED", `duplicate option: ${flag}`);
		result[key] = value;
	}
	if (!result.flow) throw new UiQaError("FAILED", "--flow is required");
	return result;
}

function readFlow(flowPath, requireSteps) {
	const stat = fs.statSync(flowPath);
	if (!stat.isFile() || stat.size > MAX_FLOW_BYTES) {
		throw new UiQaError("FAILED", "UI QA flow must be a regular JSONC file no larger than 16 MiB");
	}
	const errors = [];
	const flow = parseJsonc(fs.readFileSync(flowPath, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		throw new UiQaError("FAILED", `invalid UI QA JSONC: ${printParseErrorCode(errors[0].error)}`);
	}
	if (!isObject(flow) || !isObject(flow.target)) throw new UiQaError("FAILED", "UI QA flow must define target");
	if (flow.version !== undefined && flow.version !== 1) throw new UiQaError("FAILED", "UI QA flow version must be 1");
	if (requireSteps && (!Array.isArray(flow.steps) || flow.steps.length < 1 || flow.steps.length > MAX_STEPS)) {
		throw new UiQaError("FAILED", `UI QA flow must define between 1 and ${MAX_STEPS} steps`);
	}
	if (!requireSteps && flow.steps !== undefined && (!Array.isArray(flow.steps) || flow.steps.length > MAX_STEPS)) {
		throw new UiQaError("FAILED", `UI QA flow steps must be an array with at most ${MAX_STEPS} entries`);
	}
	return flow;
}

function resolveAgentDirectory(projectRoot, value) {
	if (typeof value !== "string" || value.length === 0) throw new UiQaError("FAILED", `${AGENT_DIR_ENV} is required`);
	const subagentRoot = path.join(projectRoot, ".pi", "subagents");
	const resolved = path.resolve(value);
	if (!fs.existsSync(resolved)) throw new UiQaError("FAILED", "UI QA agent directory is missing");
	const real = fs.realpathSync(resolved);
	assertInside(subagentRoot, real, "UI QA agent directory");
	assertNoSymlinkComponents(projectRoot, real, "UI QA agent directory");
	if (!fs.statSync(real).isDirectory()) throw new UiQaError("FAILED", "UI QA agent directory must be a directory");
	for (const [name, label] of [["prompt.md", "prompt"], ["project_cwd", "project metadata"], ["subagent_type", "type metadata"]]) {
		const file = path.join(real, name);
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new UiQaError("FAILED", `UI QA ${label} is missing`);
		assertNoSymlinkComponents(real, file, `UI QA ${label}`);
	}
	const recordedProject = fs.readFileSync(path.join(real, "project_cwd"), "utf8").trim();
	if (!recordedProject || fs.realpathSync(recordedProject) !== projectRoot) throw new UiQaError("FAILED", "UI QA agent directory belongs to another project");
	const type = fs.readFileSync(path.join(real, "subagent_type"), "utf8").trim();
	if (type !== "ui-qa" && type !== "browser-qa") throw new UiQaError("FAILED", "UI QA runner requires a ui-qa/browser-qa agent directory");
	const workspace = path.join(real, WORKSPACE_RELATIVE);
	validatePrivateDirectory(real, workspace, "UI QA workspace");
	validatePrivateDirectory(workspace, path.join(workspace, FLOW_RELATIVE), "UI QA flow workspace");
	return real;
}

function resolveFlowPath(workspaceDir, value) {
	if (typeof value !== "string" || !value) throw new UiQaError("FAILED", "flow path is missing");
	const root = fs.realpathSync(path.join(workspaceDir, FLOW_RELATIVE));
	const resolved = path.resolve(root, value);
	assertInside(root, resolved, "UI QA flow");
	if (!fs.existsSync(resolved)) throw new UiQaError("FAILED", "UI QA flow is missing");
	assertNoSymlinkComponents(root, resolved, "UI QA flow");
	const real = fs.realpathSync(resolved);
	assertInside(root, real, "UI QA flow");
	const stat = fs.statSync(real);
	if (!stat.isFile()) throw new UiQaError("FAILED", "UI QA flow must be a regular file");
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new UiQaError("FAILED", "UI QA flow must use private permissions (0600)");
	return real;
}

function validatePrivateDirectory(root, target, label) {
	assertInside(root, target, label);
	if (!fs.existsSync(target)) throw new UiQaError("FAILED", `${label} is missing`);
	assertNoSymlinkComponents(root, target, label);
	const stat = fs.statSync(target);
	if (!stat.isDirectory()) throw new UiQaError("FAILED", `${label} must be a directory`);
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new UiQaError("FAILED", `${label} must use private permissions (0700)`);
}

function createExclusivePrivateDirectory(root, target) {
	const resolvedRoot = fs.realpathSync(root);
	assertInside(resolvedRoot, target, "evidence directory");
	let current = resolvedRoot;
	for (const part of path.relative(resolvedRoot, target).split(path.sep)) {
		current = path.join(current, part);
		if (fs.existsSync(current)) {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UiQaError("FAILED", "evidence path must contain only real directories");
			if (current === target) throw new UiQaError("FAILED", "evidence directory already exists");
			if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new UiQaError("FAILED", "evidence directories must use mode 0700");
		} else fs.mkdirSync(current, { mode: 0o700 });
	}
}

function createProgress(workspaceDir) {
	const file = path.join(workspaceDir, "progress.jsonl");
	let stat;
	try { stat = fs.lstatSync(file); } catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (stat) {
		if (stat.isSymbolicLink() || !stat.isFile()) throw new UiQaError("FAILED", "UI QA progress path must be a regular file");
		if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new UiQaError("FAILED", "UI QA progress file must use private permissions (0600)");
	}
	return (stage, details = {}) => {
		if (fs.existsSync(file) && fs.statSync(file).size >= PROGRESS_MAX_BYTES) fs.writeFileSync(file, "", { mode: 0o600 });
		fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), stage, ...details })}\n`, { mode: 0o600 });
	};
}

function normalizeResult(value) {
	const artifacts = isObject(value.artifacts) ? value.artifacts : {};
	const normalizedValue = value.status === "BLOCKED" && !nonEmptyString(value.remediation)
		? { ...value, remediation: DEFAULT_BLOCKED_REMEDIATION }
		: value;
	const blockedHandoff = buildBlockedHandoff(normalizedValue);
	return {
		...normalizedValue,
		...(blockedHandoff ? { blockedHandoff } : {}),
		artifacts: {
			screenshots: artifactArray(artifacts.screenshots),
			videos: artifactArray(artifacts.videos),
			traces: artifactArray(artifacts.traces),
			terminalCaptures: artifactArray(artifacts.terminalCaptures),
			accessibilitySnapshots: artifactArray(artifacts.accessibilitySnapshots),
			observations: artifactArray(artifacts.observations),
			downloads: artifactArray(artifacts.downloads),
		},
		assertions: Array.isArray(value.assertions) ? value.assertions : [],
		observations: Array.isArray(value.observations) ? value.observations : [],
	};
}

function buildBlockedHandoff(value) {
	if (value.status !== "BLOCKED") return null;
	const selection = isObject(value.selection) ? value.selection : {};
	const candidates = Array.isArray(selection.candidateBackends) ? selection.candidateBackends : [];
	const selectedCandidate = candidates.find((entry) => isObject(entry) && entry.backend === selection.selectedBackend);
	const reason = nonEmptyString(value.reason)
		? value.reason
		: (nonEmptyString(selection.whySelected)
			? selection.whySelected
			: "UI QA is blocked by an unavailable required capability or environment prerequisite");
	const remediation = nonEmptyString(value.remediation) ? value.remediation : DEFAULT_BLOCKED_REMEDIATION;
	const platformDriver = nonEmptyString(selection.platformDriver)
		? selection.platformDriver
		: (nonEmptyString(selectedCandidate?.platformDriver) ? selectedCandidate.platformDriver : undefined);
	return {
		...(nonEmptyString(selection.selectedBackend) ? { backend: selection.selectedBackend } : {}),
		...(platformDriver ? { platformDriver } : {}),
		missingCapabilities: stringArray(selection.missingCapabilities),
		reason,
		remediation,
		manualActionRequired: true,
		automaticRemediationAttempted: false,
	};
}

function artifactArray(value) {
	return Array.isArray(value) ? value.filter((entry) => isObject(entry) && typeof entry.path === "string") : [];
}

function artifactRecord(evidenceDir, value, kind) {
	const resolved = path.resolve(evidenceDir, value);
	assertInside(evidenceDir, resolved, `${kind} artifact`);
	return { path: resolved, uri: pathToFileURL(resolved).href };
}

function writeJsonPrivate(file, value) {
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function writeStatus(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseRunnerTimeout(value) {
	if (value === undefined) return DEFAULT_RUNNER_TIMEOUT_MS;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 100 || parsed > MAX_RUNNER_TIMEOUT_MS) {
		throw new UiQaError("FAILED", `--runner-timeout-ms must be between 100 and ${MAX_RUNNER_TIMEOUT_MS}`);
	}
	return Math.round(parsed);
}

function safeRunId(value) {
	if (typeof value !== "string" || !SAFE_NAME.test(value) || value === "." || value.includes("..")) {
		throw new UiQaError("FAILED", "run id must contain only letters, digits, dot, underscore, or dash without dot segments");
	}
	return value;
}

function timestamp() {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function relativePath(root, value) {
	return (path.relative(root, value) || ".").split(path.sep).join("/");
}

function isInside(root, target) {
	const relative = path.relative(root, target);
	return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertInside(root, target, label) {
	if (!isInside(root, target)) throw new UiQaError("FAILED", `${label} must stay inside its owning workspace`);
}

function assertNoSymlinkComponents(root, target, label) {
	let current = root;
	for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		if (fs.lstatSync(current).isSymbolicLink()) throw new UiQaError("FAILED", `${label} must not use symbolic links`);
	}
}

function stringArray(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function nonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function safeReason(error) {
	return error instanceof Error ? error.message : String(error);
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
