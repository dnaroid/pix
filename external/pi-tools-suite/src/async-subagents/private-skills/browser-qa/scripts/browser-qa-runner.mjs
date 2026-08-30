#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { strFromU8, strToU8, unzipSync, zipSync } from "../vendor/fflate.mjs";

const CONFIG_RELATIVE = ".pi/qa_auth.jsonc";
const AUTH_SECRET_PLACEHOLDER = /^__PI_QA_SECRET_[1-9][0-9]*__$/;
const SUBAGENT_AGENT_DIR_ENV = "PI_SUBAGENT_AGENT_DIR";
const QA_WORKSPACE_RELATIVE = "browser-qa";
const EVIDENCE_RELATIVE = "evidence";
const UI_READY_SETTLE_MS = 500;
const UI_READY_POLL_MS = 100;
const FORM_VIDEO_STEP_DELAY_MS = UI_READY_SETTLE_MS;
const POPUP_VIDEO_SETTLE_MS = 250;
const CLICK_VIDEO_DELAY_MS = 120;
const DRAG_VIDEO_REPLAY_MS = 450;
const UI_READY_ACTIONS = new Set([
	"goto", "reload", "click", "doubleClick", "hover", "fill", "press", "check", "uncheck", "selectOption",
	"dragTo", "uploadFiles", "openPopup", "download", "wheel", "evaluate",
]);
const VISIBLE_BUSY_SELECTOR = [
	'[aria-busy="true"]:visible',
	'[role="progressbar"]:visible',
	'[data-loading="true"]:visible',
	'[data-state="loading"]:visible',
	'[data-testid*="loading" i]:visible',
	'[data-testid*="spinner" i]:visible',
	'[data-testid*="skeleton" i]:visible',
	'.loading:visible',
	'[class*="spinner" i]:visible',
	'[class*="skeleton" i]:visible',
].join(", ");
const EXIT_AUTH_UPDATE_REQUIRED = 42;
const EXIT_RUNNER_TIMEOUT = 124;
const DEFAULT_RUNNER_TIMEOUT_MS = 90_000;
const MAX_RUNNER_TIMEOUT_MS = 100_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const HARD_EXIT_GRACE_MS = 15_000;
const PROGRESS_LOG_MAX_BYTES = 1024 * 1024;
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
const MIN_VIEWPORT = Object.freeze({ width: 320, height: 240 });
const MAX_VIEWPORT = Object.freeze({ width: 3840, height: 2160 });
const MAX_SCROLL_DISTANCE = 1_000_000;
const ASSERTION_POLL_INTERVAL_MS = 100;
const MAX_POPUPS = 3;
const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FLOW_BYTES = 16 * 1024 * 1024;
const DEFAULT_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_ENVIRONMENT = Object.freeze({
	locale: "en-US",
	timezoneId: "UTC",
	colorScheme: "light",
	reducedMotion: "reduce",
});
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]{0,127}$/;
const PROFILE_ID = /^[A-Za-z0-9._-]+$/;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const DIALOG_TYPES = new Set(["alert", "beforeunload", "confirm", "prompt"]);
const AUTH_TEMPLATE = `{
  // Authenticated browser QA requires at least one project-local profile.
  // Fill and uncomment a profile below. Keep this file private.
  "profiles": {
    // "staging-user": {
    //   "description": "Staging user",
    //   "traits": ["role:user"],
    //   "baseUrl": "https://staging.example.test",
    //   "allowedOrigins": ["https://staging.example.test"],
    //   "auth": {
    //     "type": "form",
    //     "loginUrl": "https://staging.example.test/login",
    //     "fields": [
    //       { "selector": "input[name=email]", "value": "" },
    //       { "selector": "input[name=password]", "value": "" }
    //     ],
    //     "submitSelector": "button[type=submit]",
    //     "success": { "selector": "[data-testid=user-menu]" }
    //   }
    // }
  }
}
`;
if (isMainThread) process.umask(0o077);

class QaStatusError extends Error {
	constructor(status, reason, exitCode, profileId, details = {}) {
		super(reason);
		this.status = status;
		this.reason = reason;
		this.exitCode = exitCode;
		this.profileId = profileId;
		this.details = details;
	}
}

// Declared before the main() dispatch below: main() runs synchronously up to
// its first await, so module state it touches must already be initialized.
let runnerMayHaveBrowserChildren = false;

if (!isMainThread && workerData?.operation === "sanitize_trace") {
	if (process.env.BROWSER_QA_TEST_HANG_STAGE === "trace_sanitize") {
		setInterval(() => {}, 1000);
	} else {
		try {
			sanitizeTraceArchive(workerData.tracePath, workerData.secrets);
			parentPort?.postMessage({ success: true });
		} catch (error) {
			parentPort?.postMessage({ success: false, reason: redact(safeReason(error), workerData.secrets) });
		}
	}
} else main().catch((error) => {
	const statusError = error instanceof QaStatusError
		? error
		: new QaStatusError("QA_RUN_FAILED", safeReason(error), 1);
	terminateRunnerDescendants();
	writeStatus({
		status: statusError.status,
		profile: statusError.profileId,
		...(statusError.status === "QA_AUTH_UPDATE_REQUIRED" ? { file: CONFIG_RELATIVE } : {}),
		reason: statusError.reason,
		...statusError.details,
	});
	process.exit(statusError.exitCode);
});

async function main() {
	// End the synchronous first tick before running any command handler: the
	// handler bodies run ahead of later module-level declarations otherwise,
	// and a synchronous failure (e.g. playwright failing to load) would hit
	// temporal-dead-zone errors in the catch blocks instead of clean reasons.
	await null;
	const [command = "profiles", ...rawArgs] = process.argv.slice(2);
	const cwd = fs.realpathSync(process.cwd());
	if (command === "auth") {
		const [authCommand, ...authArgs] = rawArgs;
		if (authCommand !== "scaffold") throw new QaStatusError("QA_RUN_FAILED", `unknown auth command: ${authCommand ?? "(missing)"}`, 1);
		await runAuthScaffold(cwd, parseAuthScaffoldArgs(authArgs));
		return;
	}
	if (command === "profiles") {
		const requireAuth = rawArgs.length === 1 && rawArgs[0] === "--require-auth";
		if (rawArgs.length > 0 && !requireAuth) {
			throw new QaStatusError("QA_RUN_FAILED", `invalid profiles argument: ${rawArgs[0]}`, 1);
		}
		const config = readAuthConfig(cwd, requireAuth);
		writeStatus({ status: "QA_PROFILES", authConfigPresent: config.present, profiles: safeProfiles(config.profiles) });
		return;
	}
	if (command !== "run") throw new QaStatusError("QA_RUN_FAILED", `unknown command: ${command}`, 1);

	const args = parseArgs(rawArgs);
	const selected = args.profile
		? selectProfile(readAuthConfig(cwd, true, true).profiles, args.profile)
		: createPublicProfile(args.baseUrl);
	const profileId = selected.id;
	const profile = selected.profile;
	const secrets = collectSecrets(profile.auth);
	let hardExitTimer;
	let progress;
	try {
		const agentDir = resolveBrowserQaAgentDirectory(cwd, process.env[SUBAGENT_AGENT_DIR_ENV]);
		const workspaceDir = path.join(agentDir, QA_WORKSPACE_RELATIVE);
		const runnerTimeoutMs = parseRunnerTimeout(args.runnerTimeoutMs, profileId);
		const deadline = Date.now() + runnerTimeoutMs;
		progress = createRunnerProgress(workspaceDir);
		progress("runner_started", { timeoutMs: runnerTimeoutMs });
		hardExitTimer = setTimeout(() => {
			const lastStage = progress?.lastStage?.();
			progress?.("hard_timeout", { timeoutMs: runnerTimeoutMs });
			terminateRunnerDescendants();
			writeStatus({
				status: "QA_RUN_FAILED",
				profile: profileId,
				reason: `browser QA runner did not exit within ${runnerTimeoutMs + HARD_EXIT_GRACE_MS} ms${lastStage ? `; last stage: ${lastStage}` : ""}`,
				timedOut: true,
				...(lastStage ? { lastStage } : {}),
			});
			process.exit(EXIT_RUNNER_TIMEOUT);
		}, runnerTimeoutMs + HARD_EXIT_GRACE_MS);
		await runQa({ cwd, agentDir, args, profileId, profile, deadline, progress });
	} catch (error) {
		if (error instanceof QaStatusError) throw error;
		throw new QaStatusError("QA_RUN_FAILED", redact(safeReason(error), secrets), 1, profileId);
	} finally {
		if (hardExitTimer) clearTimeout(hardExitTimer);
		progress?.("runner_finished");
	}
}

async function runQa({ cwd, agentDir, args, profileId, profile, deadline, progress }) {
	if (!args.flow) throw new QaStatusError("QA_RUN_FAILED", "--flow is required", 1, profileId);
	const workspaceDir = path.join(agentDir, QA_WORKSPACE_RELATIVE);
	const flowPath = resolveExistingPrivateFile(workspaceDir, args.flow, "QA flow", false);
	const flow = readFlow(flowPath, profileId);
	const viewport = resolveViewport(flow, profileId);
	const environment = resolveEnvironment(flow, profileId);
	const allowedOrigins = normalizeAllowedOrigins(profile.allowedOrigins, profileId);
	const baseURL = normalizeBaseUrl(args.baseUrl ?? profile.baseUrl ?? allowedOrigins[0], allowedOrigins, profileId);
	validateAuthConfiguration(cwd, profile.auth, allowedOrigins, profileId);
	const runId = safeRunId(args.runId ?? `${timestamp()}-${profileId}`);
	const evidenceDir = path.join(workspaceDir, EVIDENCE_RELATIVE, runId, profileId);
	createExclusivePrivateDirectory(agentDir, evidenceDir);

	progress("playwright_load_started");
	const playwright = loadPlaywright(cwd);
	progress("playwright_load_finished");
	runnerMayHaveBrowserChildren = true;
	const browser = await runStage(progress, "browser_launch", deadline, () => playwright.chromium.launch({ headless: true }), profileId);
	let context;
	let page;
	const videos = [];
	let outcome = "passed";
	let failure;
	const observations = [];
	const runtimeSecrets = collectSecrets(profile.auth);
	const tracePath = path.join(evidenceDir, "trace.zip");
	try {
		const contextOptions = await runStage(progress, "auth_context_options", deadline, () => contextOptionsForAuth({ cwd, profileId, profile, allowedOrigins }), profileId);
		context = await runStage(progress, "context_create", deadline, () => browser.newContext({
			...contextOptions,
			baseURL,
			...environment,
			serviceWorkers: "block",
			recordVideo: { dir: evidenceDir, size: viewport },
			viewport,
		}), profileId);
		await runStage(
			progress,
			"interaction_visualizer_install",
			deadline,
			() => context.addInitScript(installInteractionVisualizer, { dragReplayMs: DRAG_VIDEO_REPLAY_MS }),
			profileId,
		);
		await runStage(progress, "origin_guard_install", deadline, () => installOriginGuard(context, allowedOrigins, profile.auth), profileId);
		await runStage(progress, "context_auth_apply", deadline, () => applyContextAuth(context, profile.auth, allowedOrigins, baseURL, profileId), profileId);
		page = await runStage(progress, "page_create", deadline, () => context.newPage(), profileId);
		videos.push({ name: "video.webm", video: page.video() });
		await runStage(progress, "form_auth_apply", deadline, () => applyFormAuth(page, profile.auth, allowedOrigins, profileId), profileId);
		const initialStorageState = await runStage(progress, "storage_state_collect", deadline, () => context.storageState(), profileId);
		runtimeSecrets.push(...collectStorageStateSecrets(initialStorageState));
		await runStage(progress, "trace_start", deadline, () => context.tracing.start({ screenshots: true, snapshots: true, sources: false }), profileId);
		await runStage(progress, "flow_execute", deadline, () => executeFlow({ context, page, baseURL, evidenceDir, flow, allowedOrigins, profileId, secrets: runtimeSecrets, observations, videos }), profileId);
		await runStage(progress, "secret_exposure_check", deadline, () => assertBrowserDoesNotExposeSecrets(context, page, runtimeSecrets, profileId), profileId);
		await runStage(progress, "final_screenshot", deadline, () => page.screenshot({ path: path.join(evidenceDir, "final.png"), fullPage: true }), profileId);
	} catch (error) {
		outcome = error instanceof QaStatusError ? error.status : "failed";
		failure = error;
		if (page && !page.isClosed() && !error.suppressEvidence) {
			try {
				await runCleanupStage(progress, "failure_screenshot", () => page.screenshot({ path: path.join(evidenceDir, "failure.png"), fullPage: true }));
			} catch { /* best effort */ }
		}
	} finally {
		const cleanupDeadline = Date.now() + CLEANUP_TIMEOUT_MS;
		if (context) {
			try {
				const finalStorageState = await runCleanupStage(progress, "storage_state_finalize", () => context.storageState(), cleanupDeadline);
				runtimeSecrets.push(...collectStorageStateSecrets(finalStorageState));
			} catch { /* best effort */ }
			try {
				await runCleanupStage(progress, "trace_stop", () => context.tracing.stop({ path: tracePath }), cleanupDeadline);
				await runCleanupStage(
					progress,
					"trace_sanitize",
					() => sanitizeTraceArchiveInWorker(tracePath, runtimeSecrets, cleanupDeadline),
					cleanupDeadline,
				);
			} catch (error) {
				fs.rmSync(tracePath, { force: true });
				if (!failure) {
					outcome = "failed";
					failure = new Error(`trace evidence could not be sanitized: ${safeReason(error)}`);
				}
			}
			await runCleanupStage(progress, "context_close", () => context.close(), cleanupDeadline).catch(() => {});
		}
		for (const [index, entry] of videos.entries()) {
			if (!entry.video) continue;
			try {
				const generatedVideo = await runCleanupStage(progress, `video_${index + 1}_finalize`, () => entry.video.path(), cleanupDeadline);
				if (!fs.existsSync(generatedVideo)) continue;
				if (entry.discard) fs.rmSync(generatedVideo, { force: true });
				else fs.renameSync(generatedVideo, path.join(evidenceDir, entry.name));
			} catch { /* best effort */ }
		}
		await runCleanupStage(progress, "browser_close", () => browser.close(), cleanupDeadline).catch(() => {});
	}
	try {
		for (const name of fs.readdirSync(evidenceDir).filter((name) => /^download-[A-Za-z0-9._-]+\.bin$/.test(name))) {
			assertFileDoesNotExposeSecrets(path.join(evidenceDir, name), runtimeSecrets, profileId);
		}
	} catch (error) {
		outcome = error instanceof QaStatusError ? error.status : "failed";
		failure = error;
	}
	if (failure?.suppressEvidence) removeVisualEvidence(evidenceDir);

	const evidence = existingEvidence(evidenceDir);
	const evidenceDetails = {
		evidenceDir: relativePath(cwd, evidenceDir),
		evidence,
		artifacts: artifactManifest(evidenceDir, evidence),
		viewport,
		environment,
		...(observations.length > 0 ? { observations } : {}),
	};
	writeJsonPrivate(path.join(evidenceDir, "result.json"), {
		status: outcome,
		profile: profileId,
		...evidenceDetails,
	});
	if (failure) {
		if (failure instanceof QaStatusError) {
			failure.reason = redact(failure.reason, collectSecrets(profile.auth));
			failure.details = { ...failure.details, ...evidenceDetails };
			throw failure;
		}
		throw new QaStatusError(
			"QA_RUN_FAILED",
			redact(safeReason(failure), collectSecrets(profile.auth)),
			1,
			profileId,
			evidenceDetails,
		);
	}
	writeStatus({ status: "QA_PASSED", profile: profileId, ...evidenceDetails });
}

function installInteractionVisualizer({ dragReplayMs } = {}) {
	const replayDuration = Number.isFinite(dragReplayMs) && dragReplayMs > 0 ? dragReplayMs : 1_000;
	const state = {
		host: undefined,
		root: undefined,
		svg: undefined,
		cursor: undefined,
		cursorTimer: undefined,
		dragTimer: undefined,
		pressed: false,
		dragging: false,
		points: [],
		preparedPoints: undefined,
		path: undefined,
		replayAnimations: [],
		replayTimer: undefined,
		replayPath: undefined,
		replayCursor: undefined,
	};

	const topLayerContainer = (event) => {
		for (const candidate of event?.composedPath?.() ?? []) {
			if (!(candidate instanceof Element)) continue;
			if (candidate === document.fullscreenElement) return candidate;
			if (typeof HTMLDialogElement !== "undefined" && candidate instanceof HTMLDialogElement && candidate.open) return candidate;
			try {
				if (candidate.matches(":popover-open")) return candidate;
			} catch { /* unsupported selector */ }
		}
		return document.fullscreenElement ?? document.documentElement;
	};
	const ensureRoot = (container = document.documentElement) => {
		if (state.host?.isConnected && state.root && state.svg && state.cursor) {
			if (state.host.parentElement !== container) container.appendChild(state.host);
			return state.svg;
		}
		const host = document.createElement("div");
		host.setAttribute("data-pi-browser-qa-visualizer", "");
		host.setAttribute("aria-hidden", "true");
		const root = host.attachShadow({ mode: "closed" });
		const stylesheet = new CSSStyleSheet();
		stylesheet.replaceSync(`
			:host { all: initial; position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; overflow: visible !important; pointer-events: none !important; z-index: 2147483647 !important; }
			svg { position: fixed; inset: 0; width: 100vw; height: 100vh; overflow: visible; pointer-events: none; }
			.cursor { fill: #0ea5e9; stroke: #fff; stroke-width: 3; filter: drop-shadow(0 0 2px #082f49) drop-shadow(0 2px 4px #000a); opacity: 0; transition: opacity 90ms linear; }
			.cursor.visible { opacity: 1; }
			.cursor.dragging { fill: #ff7a00; }
			.cursor.replay { stroke-width: 4; filter: drop-shadow(0 0 3px #fff) drop-shadow(0 0 10px #ff7a00) drop-shadow(0 3px 5px #000c); transform-box: view-box; transform-origin: 0 0; }
			.pulse { fill: none; stroke: #fbbf24; stroke-width: 4; filter: drop-shadow(0 0 2px #fff) drop-shadow(0 0 7px #f59e0b); transform-box: fill-box; transform-origin: center; }
			.drop { fill: none; stroke: #22c55e; stroke-width: 6; filter: drop-shadow(0 0 3px #fff) drop-shadow(0 0 12px #16a34a); transform-box: fill-box; transform-origin: center; }
			path { fill: none; stroke: #ff7a00; stroke-width: 8; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 0 3px #fff) drop-shadow(0 0 8px #ff7a00) drop-shadow(0 3px 4px #000c); }
		`);
		root.adoptedStyleSheets = [stylesheet];
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		const cursor = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		cursor.setAttribute("r", "9");
		cursor.setAttribute("class", "cursor");
		svg.appendChild(cursor);
		root.appendChild(svg);
		container.appendChild(host);
		state.host = host;
		state.root = root;
		state.svg = svg;
		state.cursor = cursor;
		return svg;
	};

	const dragReplayEvent = "pi-browser-qa-drag-replay";
	const pointFor = (event) => ({ x: event.clientX, y: event.clientY });
	const position = (element, point) => {
		element.setAttribute("cx", String(point.x));
		element.setAttribute("cy", String(point.y));
	};
	const showCursor = (point, dragging = state.dragging, container) => {
		ensureRoot(container);
		position(state.cursor, point);
		state.cursor.classList.toggle("dragging", dragging);
		state.cursor.classList.add("visible");
		clearTimeout(state.cursorTimer);
		state.cursorTimer = setTimeout(() => state.cursor?.classList.remove("visible"), 360);
	};
	const marker = (className, point, container) => {
		const element = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		element.setAttribute("r", className === "drop" ? "17" : "9");
		element.setAttribute("class", className);
		position(element, point);
		ensureRoot(container).appendChild(element);
		element.animate(
			className === "drop"
				? [{ opacity: 1, transform: "scale(.65)" }, { opacity: 0, transform: "scale(2.4)" }]
				: [{ opacity: 1, transform: "scale(.55)" }, { opacity: 0, transform: "scale(2.8)" }],
			{ duration: 460, easing: "ease-out", fill: "forwards" },
		);
		setTimeout(() => element.remove(), 520);
	};
	const clearReplay = () => {
		clearTimeout(state.replayTimer);
		for (const animation of state.replayAnimations) animation.cancel();
		state.replayCursor?.remove();
		state.replayPath?.remove();
		state.replayAnimations = [];
		state.replayTimer = undefined;
		state.replayCursor = undefined;
		state.replayPath = undefined;
	};
	const replayDrag = (points, finishedPath, container) => {
		if (!finishedPath || points.length === 0) return;
		clearReplay();
		const svg = ensureRoot(container);
		const replayCursor = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		replayCursor.setAttribute("r", "14");
		replayCursor.setAttribute("class", "cursor visible dragging replay");
		svg.appendChild(replayCursor);
		state.replayCursor = replayCursor;
		state.replayPath = finishedPath;

		const cumulative = [0];
		for (let index = 1; index < points.length; index += 1) {
			const previous = points[index - 1];
			const current = points[index];
			cumulative.push(cumulative[index - 1] + Math.hypot(current.x - previous.x, current.y - previous.y));
		}
		const totalLength = cumulative[cumulative.length - 1];
		const firstPoint = points[0];
		const finalPoint = points[points.length - 1];
		const cursorKeyframes = points
			.map((point, index) => ({
				offset: totalLength > 0 ? cumulative[index] / totalLength : index / Math.max(points.length - 1, 1),
				transform: `translate(${point.x}px, ${point.y}px)`,
			}))
			.filter((frame, index, frames) => index === 0 || index === frames.length - 1 || frame.offset > frames[index - 1].offset);
		if (cursorKeyframes.length === 1) cursorKeyframes.push({ ...cursorKeyframes[0], offset: 1 });
		cursorKeyframes[0].offset = 0;
		cursorKeyframes[cursorKeyframes.length - 1].offset = 1;
		const pathLength = Math.max(finishedPath.getTotalLength(), totalLength, 1);
		finishedPath.setAttribute("stroke-dasharray", `${pathLength} ${pathLength}`);
		finishedPath.setAttribute("stroke-dashoffset", String(pathLength));
		replayCursor.setAttribute("cx", "0");
		replayCursor.setAttribute("cy", "0");
		replayCursor.setAttribute("transform", `translate(${firstPoint.x} ${firstPoint.y})`);
		state.replayAnimations = [
			replayCursor.animate(cursorKeyframes, { duration: replayDuration, easing: "linear", fill: "forwards" }),
			finishedPath.animate(
				[{ strokeDashoffset: `${pathLength}px` }, { strokeDashoffset: "0px" }],
				{ duration: replayDuration, easing: "linear", fill: "forwards" },
			),
		];
		const finishReplay = () => {
			state.replayAnimations = [];
			state.replayTimer = undefined;
			state.replayCursor = undefined;
			state.replayPath = undefined;
			replayCursor.remove();
			marker("drop", finalPoint, container);
			finishedPath.removeAttribute("stroke-dasharray");
			finishedPath.removeAttribute("stroke-dashoffset");
			finishedPath.animate(
				[{ opacity: 1, offset: 0 }, { opacity: 1, offset: .55 }, { opacity: 0, offset: 1 }],
				{ duration: 460, easing: "ease-out", fill: "forwards" },
			);
			setTimeout(() => finishedPath.remove(), 520);
		};
		state.replayTimer = setTimeout(finishReplay, replayDuration);
	};
	const scheduleDragCleanup = () => {
		clearTimeout(state.dragTimer);
		state.dragTimer = setTimeout(cancelDrag, 5_000);
	};
	const updatePath = (point, container) => {
		if (state.points.length === 0) state.points.push(point);
		const previous = state.points[state.points.length - 1];
		if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 3) state.points.push(point);
		if (state.points.length > 80) state.points.splice(1, state.points.length - 80);
		if (!state.path) {
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			ensureRoot(container).appendChild(path);
			state.path = path;
		}
		state.path.setAttribute("d", state.points.map((entry, index) => `${index === 0 ? "M" : "L"}${entry.x} ${entry.y}`).join(" "));
		scheduleDragCleanup();
	};
	const beginDrag = (point, container) => {
		if (!state.dragging) clearReplay();
		state.dragging = true;
		state.points = state.points.length > 0 ? state.points : [point];
		updatePath(point, container);
		showCursor(point, true, container);
	};
	const finishDrag = (point, container) => {
		if (!state.dragging) {
			state.points = [];
			return;
		}
		updatePath(point, container);
		const finishedPath = state.path;
		const finishedPoints = state.preparedPoints ?? [...state.points];
		state.preparedPoints = undefined;
		if (finishedPath) {
			finishedPath.setAttribute("d", finishedPoints.map((entry, index) => `${index === 0 ? "M" : "L"}${entry.x} ${entry.y}`).join(" "));
		}
		clearTimeout(state.dragTimer);
		state.dragging = false;
		state.points = [];
		state.path = undefined;
		state.cursor?.classList.remove("visible", "dragging");
		replayDrag(finishedPoints, finishedPath, container);
	};
	function cancelDrag() {
		clearTimeout(state.dragTimer);
		state.path?.remove();
		state.pressed = false;
		state.dragging = false;
		state.points = [];
		state.path = undefined;
		state.cursor?.classList.remove("dragging");
	}

	document.addEventListener(dragReplayEvent, (event) => {
		const points = event.detail?.points;
		if (!Array.isArray(points) || points.length < 2) return;
		if (!points.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) return;
		state.preparedPoints = points.map(({ x, y }) => ({ x, y }));
	}, true);
	document.addEventListener("pointermove", (event) => {
		const point = pointFor(event);
		const container = topLayerContainer(event);
		if (state.pressed && (event.buttons & 1) === 1) {
			const start = state.points[0] ?? point;
			if (state.dragging || Math.hypot(point.x - start.x, point.y - start.y) >= 6) beginDrag(point, container);
			if (state.dragging) updatePath(point, container);
		}
		showCursor(point, state.dragging, container);
	}, true);
	document.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		const point = pointFor(event);
		const container = topLayerContainer(event);
		state.pressed = true;
		state.points = [point];
		marker("pulse", point, container);
		showCursor(point, false, container);
	}, true);
	document.addEventListener("pointerup", (event) => {
		state.pressed = false;
		finishDrag(pointFor(event), topLayerContainer(event));
	}, true);
	document.addEventListener("pointercancel", (event) => {
		showCursor(pointFor(event), false, topLayerContainer(event));
		cancelDrag();
	}, true);
	document.addEventListener("dragstart", (event) => beginDrag(pointFor(event), topLayerContainer(event)), true);
	document.addEventListener("dragover", (event) => {
		const point = pointFor(event);
		const container = topLayerContainer(event);
		if (!state.dragging) beginDrag(point, container);
		updatePath(point, container);
		showCursor(point, true, container);
	}, true);
	document.addEventListener("drop", (event) => finishDrag(pointFor(event), topLayerContainer(event)), true);
	document.addEventListener("dragend", (event) => finishDrag(pointFor(event), topLayerContainer(event)), true);
	document.addEventListener("lostpointercapture", cancelDrag, true);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") cancelDrag();
	}, true);
	window.addEventListener("blur", cancelDrag, true);
}

async function runAuthScaffold(cwd, args) {
	const profileId = args.profile;
	if (!isSafeName(profileId) || profileId.length > 128) throw new QaStatusError("QA_RUN_FAILED", "--profile must be a safe profile id no longer than 128 characters", 1);
	const loginUrl = normalizeScaffoldUrl(args.loginUrl, "--login-url");
	const login = new URL(loginUrl);
	const baseUrl = normalizeScaffoldUrl(args.baseUrl ?? `${login.origin}/`, "--base-url", login.origin);
	const success = scaffoldSuccess(args);
	const agentDir = resolveBrowserQaAgentDirectory(cwd, process.env[SUBAGENT_AGENT_DIR_ENV]);
	const progress = createRunnerProgress(path.join(agentDir, QA_WORKSPACE_RELATIVE));
	assertAuthScaffoldWritable(cwd);
	const timeout = Math.min(parseRunnerTimeout(args.runnerTimeoutMs, profileId), 60_000);
	const deadline = Date.now() + timeout;
	let browser;
	let context;
	try {
		progress("auth_scaffold_started", { timeoutMs: timeout });
		const playwright = loadPlaywright(cwd);
		runnerMayHaveBrowserChildren = true;
		browser = await runStage(progress, "auth_scaffold_browser_launch", deadline, () => playwright.chromium.launch({ headless: true }), profileId);
		context = await runStage(progress, "auth_scaffold_context_create", deadline, () => browser.newContext({
			...DEFAULT_ENVIRONMENT,
			serviceWorkers: "block",
			viewport: DEFAULT_VIEWPORT,
		}), profileId);
		await runStage(progress, "auth_scaffold_origin_guard", deadline, () => installOriginGuard(context, [login.origin], { type: "none" }), profileId);
		const page = await runStage(progress, "auth_scaffold_page_create", deadline, () => context.newPage(), profileId);
		await runStage(progress, "auth_scaffold_login_load", deadline, () => page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout }), profileId);
		const discovered = await runStage(progress, "auth_scaffold_form_discovery", deadline, () => discoverLoginForm(page), profileId);
		if (!success && !discovered.formSelector) {
			throw new QaStatusError("QA_RUN_FAILED", "no login form was found; provide an explicit success condition for a form-less login page", 1, profileId);
		}
		const profile = {
			description: args.description ?? `Browser QA form login (${profileId})`,
			traits: ["auth:form"],
			baseUrl,
			allowedOrigins: [login.origin],
			auth: {
				type: "form",
				loginUrl,
				fields: discovered.fields.map((selector, index) => ({ selector, value: `__PI_QA_SECRET_${index + 1}__` })),
				submitSelector: discovered.submitSelector,
				success: success ?? { selector: discovered.formSelector, state: "hidden" },
			},
		};
		const replacedEmptyTemplate = writeAuthScaffold(cwd, profileId, profile);
		writeStatus({
			status: "QA_AUTH_SCAFFOLD_CREATED",
			file: CONFIG_RELATIVE,
			profile: profileId,
			action: "fill_credentials",
			placeholderCount: discovered.fields.length,
			replacedEmptyTemplate,
		});
	} catch (error) {
		if (error instanceof QaStatusError) {
			if (error.details?.timedOut) terminateRunnerDescendants();
			throw error;
		}
		if (error instanceof RunnerStageTimeoutError) {
			terminateRunnerDescendants();
			throw new QaStatusError("QA_RUN_FAILED", "auth scaffold timed out; verify the public login page and retry", EXIT_RUNNER_TIMEOUT, profileId, { timedOut: true });
		}
		throw new QaStatusError("QA_RUN_FAILED", "auth scaffold failed; verify the public login page and retry", 1, profileId);
	} finally {
		if (context) await runCleanupStage(progress, "auth_scaffold_context_close", () => context.close()).catch(terminateOnCleanupTimeout);
		if (browser) await runCleanupStage(progress, "auth_scaffold_browser_close", () => browser.close()).catch(terminateOnCleanupTimeout);
		progress("auth_scaffold_finished");
	}
}

function terminateOnCleanupTimeout(error) {
	if (error instanceof RunnerStageTimeoutError) terminateRunnerDescendants();
}

function normalizeScaffoldUrl(raw, flag, expectedOrigin) {
	if (typeof raw !== "string") throw new QaStatusError("QA_RUN_FAILED", `${flag} is required`, 1);
	try {
		const url = new URL(raw);
		if (!isSecureScaffoldUrl(url) || url.username || url.password || (expectedOrigin && url.origin !== expectedOrigin)) throw new Error();
		return url.href;
	} catch {
		throw new QaStatusError("QA_RUN_FAILED", `${flag} must use HTTPS or loopback HTTP without credentials${expectedOrigin ? " on the login origin" : ""}`, 1);
	}
}

function isSecureScaffoldUrl(url) {
	if (url.protocol === "https:") return true;
	if (url.protocol !== "http:") return false;
	const hostname = url.hostname.toLowerCase();
	return hostname === "localhost"
		|| hostname.endsWith(".localhost")
		|| /^127(?:\.[0-9]{1,3}){3}$/.test(hostname)
		|| hostname === "[::1]"
		|| hostname === "::1";
}

function scaffoldSuccess(args) {
	if (args.successUrl && args.successSelector) throw new QaStatusError("QA_RUN_FAILED", "use only one of --success-url or --success-selector", 1);
	if (args.successState && !args.successSelector) throw new QaStatusError("QA_RUN_FAILED", "--success-state requires --success-selector", 1);
	if (args.successUrl) return { url: boundedScaffoldString(args.successUrl, "--success-url") };
	if (!args.successSelector) return undefined;
	const state = args.successState ?? "visible";
	if (validLocatorState(state) !== state) throw new QaStatusError("QA_RUN_FAILED", "--success-state is invalid", 1);
	return { selector: boundedScaffoldString(args.successSelector, "--success-selector"), state };
}

function boundedScaffoldString(value, flag) {
	if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\r\n\0]/.test(value)) {
		throw new QaStatusError("QA_RUN_FAILED", `${flag} must be a non-empty single-line string no longer than 1024 characters`, 1);
	}
	return value;
}

async function discoverLoginForm(page) {
	const discovered = await page.evaluate(() => {
		const quoteAttribute = (value) => value.replace(/[\0-\x1f\x7f"\\]/g, (character) => {
			if (character === "\0") return "�";
			if (character === '"') return '\\"';
			if (character === "\\") return "\\\\";
			return `\\${character.codePointAt(0).toString(16)} `;
		});
		const unique = (selector) => {
			try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
		};
		const selectorFor = (element) => {
			if (element.id) {
				const selector = `[id="${quoteAttribute(element.id)}"]`;
				if (unique(selector)) return selector;
			}
			for (const attribute of ["data-testid", "data-test", "name", "aria-label"]) {
				const value = element.getAttribute(attribute);
				if (!value) continue;
				const selector = `${element.tagName.toLowerCase()}[${attribute}="${quoteAttribute(value)}"]`;
				if (unique(selector)) return selector;
			}
			const parts = [];
			let current = element;
			while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
				const tag = current.tagName.toLowerCase();
				const siblings = [...current.parentElement.children].filter((item) => item.tagName === current.tagName);
				parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
				const selector = parts.join(" > ");
				if (unique(selector)) return selector;
				current = current.parentElement;
			}
			return parts.join(" > ");
		};
		const fillable = (element) => {
			if (element.disabled || element.getAttribute("aria-hidden") === "true") return false;
			if (element instanceof HTMLTextAreaElement) return true;
			if (!(element instanceof HTMLInputElement)) return false;
			return ["email", "password", "text", "tel", "url", "search", "number"].includes((element.type || "text").toLowerCase());
		};
		const visible = (element) => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== "hidden";
		const forms = [...document.querySelectorAll("form")];
		const ranked = forms.map((form) => {
			const fields = [...form.querySelectorAll("input, textarea")].filter((element) => fillable(element) && visible(element));
			const passwordCount = fields.filter((element) => element instanceof HTMLInputElement && element.type === "password").length;
			return { form, fields, score: passwordCount * 100 + fields.length };
		}).filter((entry) => entry.fields.length > 0).sort((left, right) => right.score - left.score);
		const selected = ranked[0];
		const root = selected?.form ?? document;
		const fields = selected?.fields ?? [...document.querySelectorAll("input, textarea")].filter((element) => fillable(element) && visible(element));
		const submit = [...root.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])')].find(visible);
		return {
			fields: fields.map(selectorFor),
			submitSelector: submit ? selectorFor(submit) : undefined,
			formSelector: selected ? selectorFor(selected.form) : undefined,
		};
	});
	if (!isObject(discovered) || !Array.isArray(discovered.fields) || discovered.fields.length === 0
		|| discovered.fields.length > 10 || !discovered.fields.every(isBoundedSelector)
		|| !isBoundedSelector(discovered.submitSelector)
		|| (discovered.formSelector !== undefined && !isBoundedSelector(discovered.formSelector))) {
		throw new Error("no supported login form with fillable fields and a submit control was found");
	}
	return discovered;
}

function isBoundedSelector(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\0-\x1f\x7f]/.test(value);
}

function readAuthConfig(cwd, required = false, allowPlaceholders = false) {
	const candidate = path.join(cwd, CONFIG_RELATIVE);
	if (!fs.existsSync(candidate)) {
		if (!required) return { present: false, profiles: {} };
		let templateCreated;
		try {
			templateCreated = createAuthTemplate(cwd);
		} catch (error) {
			throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", safeReason(error), EXIT_AUTH_UPDATE_REQUIRED);
		}
		if (templateCreated) {
			throw new QaStatusError(
				"QA_AUTH_UPDATE_REQUIRED",
				"credentials are required; fill the generated auth config template and rerun browser QA",
				EXIT_AUTH_UPDATE_REQUIRED,
				undefined,
				{ action: "provide_credentials", templateCreated: true },
			);
		}
	}
	let file;
	try {
		file = resolveExistingPrivateFile(cwd, CONFIG_RELATIVE, "auth config");
	} catch (error) {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", safeReason(error), EXIT_AUTH_UPDATE_REQUIRED);
	}
	const errors = [];
	const value = parseJsonc(fs.readFileSync(file, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", `auth config is invalid JSONC (${printParseErrorCode(errors[0].error)})`, EXIT_AUTH_UPDATE_REQUIRED);
	}
	if (!isObject(value) || !isObject(value.profiles)) {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "auth config must define a profiles object", EXIT_AUTH_UPDATE_REQUIRED);
	}
	if (required && Object.keys(value.profiles).length === 0) {
		throw new QaStatusError(
			"QA_AUTH_UPDATE_REQUIRED",
			"credentials are required; auth config must define a non-empty profiles object",
			EXIT_AUTH_UPDATE_REQUIRED,
			undefined,
			{ action: "provide_credentials", templateCreated: false },
		);
	}
	const profileValues = Object.values(value.profiles);
	if (required && !allowPlaceholders && profileValues.length > 0
		&& profileValues.every((profile) => authPlaceholderCount(profile) > 0)) {
		const placeholderCount = profileValues.reduce((count, profile) => count + authPlaceholderCount(profile), 0);
		throw new QaStatusError(
			"QA_AUTH_UPDATE_REQUIRED",
			`credentials are required; replace ${placeholderCount} generated credential placeholder${placeholderCount === 1 ? "" : "s"} in the auth config`,
			EXIT_AUTH_UPDATE_REQUIRED,
			undefined,
			{ action: "fill_credentials", templateCreated: false, placeholderCount },
		);
	}
	if (Object.keys(value.profiles).some((id) => !isSafeName(id))) {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "auth profile ids may contain only letters, digits, dot, underscore, or dash", EXIT_AUTH_UPDATE_REQUIRED);
	}
	return { ...value, present: true };
}

function safeProfiles(profiles) {
	return Object.entries(profiles).map(([id, profile]) => ({
		id,
		description: isObject(profile) && typeof profile.description === "string" ? profile.description : undefined,
		traits: isObject(profile) && Array.isArray(profile.traits)
			? profile.traits.filter((value) => typeof value === "string")
			: [],
	}));
}

function selectProfile(profiles, requestedId) {
	if (!isSafeName(requestedId) || !isObject(profiles[requestedId])) {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "requested auth profile is missing or invalid", EXIT_AUTH_UPDATE_REQUIRED, requestedId);
	}
	const profile = profiles[requestedId];
	if (!isObject(profile.auth) || typeof profile.auth.type !== "string") {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "profile auth configuration is missing or invalid", EXIT_AUTH_UPDATE_REQUIRED, requestedId);
	}
	const placeholderCount = authPlaceholderCount(profile);
	if (placeholderCount > 0) {
		throw new QaStatusError(
			"QA_AUTH_UPDATE_REQUIRED",
			`credentials are required; replace ${placeholderCount} generated credential placeholder${placeholderCount === 1 ? "" : "s"} in the auth config`,
			EXIT_AUTH_UPDATE_REQUIRED,
			requestedId,
			{ action: "fill_credentials", templateCreated: false, placeholderCount },
		);
	}
	return { id: requestedId, profile };
}

function authPlaceholderCount(profile) {
	if (!isObject(profile) || !isObject(profile.auth) || profile.auth.type !== "form" || !Array.isArray(profile.auth.fields)) return 0;
	return profile.auth.fields.filter((field) => (
		isObject(field)
		&& typeof field.value === "string"
		&& AUTH_SECRET_PLACEHOLDER.test(field.value.trim())
	)).length;
}

function createPublicProfile(rawBaseUrl) {
	if (typeof rawBaseUrl !== "string") {
		throw new QaStatusError("QA_RUN_FAILED", "--base-url is required when running without --profile", 1, "public");
	}
	try {
		const url = new URL(rawBaseUrl);
		if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error();
		return {
			id: "public",
			profile: {
				baseUrl: url.href,
				allowedOrigins: [url.origin],
				auth: { type: "none" },
			},
		};
	} catch {
		throw new QaStatusError("QA_RUN_FAILED", "public --base-url must be an http(s) URL without embedded credentials", 1, "public");
	}
}

function normalizeAllowedOrigins(value, profileId) {
	if (!Array.isArray(value) || value.length === 0) {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "profile must define allowedOrigins", EXIT_AUTH_UPDATE_REQUIRED, profileId);
	}
	const origins = [];
	for (const raw of value) {
		try {
			const url = new URL(raw);
			if (!/^https?:$/.test(url.protocol) || url.origin !== raw.replace(/\/$/, "")) throw new Error();
			origins.push(url.origin);
		} catch {
			throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "allowedOrigins must contain exact http(s) origins", EXIT_AUTH_UPDATE_REQUIRED, profileId);
		}
	}
	return [...new Set(origins)];
}

function normalizeBaseUrl(raw, allowedOrigins, profileId) {
	try {
		const url = new URL(raw);
		if (url.username || url.password || !allowedOrigins.includes(url.origin)) throw new Error();
		return url.href;
	} catch {
		throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "base URL is missing or not in allowedOrigins", EXIT_AUTH_UPDATE_REQUIRED, profileId);
	}
}

function validateAuthConfiguration(cwd, auth, allowedOrigins, profileId) {
	switch (auth.type) {
		case "none":
			break;
		case "cookie":
			if (!Array.isArray(auth.cookies) || auth.cookies.length === 0) throw authError(profileId, "cookie auth requires cookies");
			for (const cookie of auth.cookies) {
				if (!isObject(cookie) || typeof cookie.name !== "string" || !cookie.name || typeof cookie.value !== "string" || !cookie.value) throw authError(profileId, "cookie auth entries require non-empty name/value strings");
				if (!cookieAllowed(cookie, allowedOrigins)) throw authError(profileId, "cookie auth domain is outside allowedOrigins");
			}
			break;
		case "localStorage":
		case "sessionStorage": {
			const origin = typeof auth.origin === "string" ? auth.origin : allowedOrigins[0];
			if (!isAllowedUrl(origin, allowedOrigins) || !isObject(auth.entries)) throw authError(profileId, `${auth.type} auth is invalid`);
			const entries = Object.entries(auth.entries);
			if (entries.length === 0 || entries.some(([key, value]) => !key || typeof value !== "string" || !value)) throw authError(profileId, `${auth.type} entries must contain non-empty string keys and values`);
			break;
		}
		case "bearer":
			if (typeof auth.token !== "string" || !auth.token) throw authError(profileId, "bearer token is missing");
			if (auth.header !== undefined && (typeof auth.header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(auth.header))) throw authError(profileId, "bearer header name is invalid");
			if (auth.prefix !== undefined && typeof auth.prefix !== "string") throw authError(profileId, "bearer prefix must be a string");
			break;
		case "form":
			if (typeof auth.loginUrl !== "string" || !isAllowedUrl(auth.loginUrl, allowedOrigins)) throw authError(profileId, "form loginUrl is missing or outside allowedOrigins");
			if (!Array.isArray(auth.fields) || auth.fields.length === 0 || auth.fields.some((field) => !isObject(field) || typeof field.selector !== "string" || !field.selector || typeof field.value !== "string" || !field.value)) throw authError(profileId, "form fields require non-empty selector/value strings");
			if (typeof auth.submitSelector !== "string" || !auth.submitSelector) throw authError(profileId, "form submitSelector is missing");
			if (!isObject(auth.success) || (typeof auth.success.url !== "string" && typeof auth.success.selector !== "string")) throw authError(profileId, "form success.url or success.selector is required");
			if (auth.success.state !== undefined && (typeof auth.success.selector !== "string" || validLocatorState(auth.success.state) !== auth.success.state)) throw authError(profileId, "form success.state requires a selector and valid locator state");
			break;
		case "storageState":
			if (typeof auth.path !== "string") throw authError(profileId, "storageState path is missing");
			try { resolveExistingPrivateFile(cwd, auth.path, "storageState"); } catch (error) { throw authError(profileId, safeReason(error)); }
			break;
		default: throw authError(profileId, `unsupported auth type: ${auth.type}`);
	}
}

function readFlow(flowPath, profileId) {
	const stat = fs.statSync(flowPath);
	if (!stat.isFile() || stat.size > MAX_FLOW_BYTES) throw new QaStatusError("QA_RUN_FAILED", "QA flow must be a regular JSONC file no larger than 16 MiB", 1, profileId);
	const errors = [];
	const flow = parseJsonc(fs.readFileSync(flowPath, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0 || !isObject(flow) || !Array.isArray(flow.steps) || flow.steps.length === 0 || flow.steps.length > 100) {
		throw new QaStatusError("QA_RUN_FAILED", "QA flow must define between 1 and 100 valid steps", 1, profileId);
	}
	return flow;
}

function resolveViewport(flow, profileId) {
	if (flow.viewport === undefined) return { ...DEFAULT_VIEWPORT };
	if (!isObject(flow.viewport)) throw new QaStatusError("QA_RUN_FAILED", "QA flow viewport must be an object with width and height", 1, profileId);
	const { width, height } = flow.viewport;
	if (!Number.isInteger(width) || !Number.isInteger(height)
		|| width < MIN_VIEWPORT.width || height < MIN_VIEWPORT.height
		|| width > MAX_VIEWPORT.width || height > MAX_VIEWPORT.height) {
		throw new QaStatusError(
			"QA_RUN_FAILED",
			`QA flow viewport must use integer dimensions from ${MIN_VIEWPORT.width}x${MIN_VIEWPORT.height} through ${MAX_VIEWPORT.width}x${MAX_VIEWPORT.height}`,
			1,
			profileId,
		);
	}
	return { width, height };
}

function resolveEnvironment(flow, profileId) {
	if (flow.environment === undefined) return { ...DEFAULT_ENVIRONMENT };
	if (!isObject(flow.environment)) throw new QaStatusError("QA_RUN_FAILED", "QA flow environment must be an object", 1, profileId);
	const environment = { ...DEFAULT_ENVIRONMENT };
	if (flow.environment.locale !== undefined) {
		if (typeof flow.environment.locale !== "string" || flow.environment.locale.length > 64) {
			throw new QaStatusError("QA_RUN_FAILED", "QA flow environment locale is invalid", 1, profileId);
		}
		try {
			environment.locale = Intl.getCanonicalLocales(flow.environment.locale)[0];
		} catch {
			throw new QaStatusError("QA_RUN_FAILED", "QA flow environment locale is invalid", 1, profileId);
		}
	}
	if (flow.environment.timezoneId !== undefined) {
		if (typeof flow.environment.timezoneId !== "string" || flow.environment.timezoneId.length > 100) {
			throw new QaStatusError("QA_RUN_FAILED", "QA flow environment timezoneId is invalid", 1, profileId);
		}
		try {
			new Intl.DateTimeFormat("en", { timeZone: flow.environment.timezoneId }).format(0);
			environment.timezoneId = flow.environment.timezoneId;
		} catch {
			throw new QaStatusError("QA_RUN_FAILED", "QA flow environment timezoneId is invalid", 1, profileId);
		}
	}
	if (flow.environment.colorScheme !== undefined) {
		if (!["light", "dark", "no-preference"].includes(flow.environment.colorScheme)) {
			throw new QaStatusError("QA_RUN_FAILED", "QA flow environment colorScheme is invalid", 1, profileId);
		}
		environment.colorScheme = flow.environment.colorScheme;
	}
	if (flow.environment.reducedMotion !== undefined) {
		if (!["reduce", "no-preference"].includes(flow.environment.reducedMotion)) {
			throw new QaStatusError("QA_RUN_FAILED", "QA flow environment reducedMotion is invalid", 1, profileId);
		}
		environment.reducedMotion = flow.environment.reducedMotion;
	}
	return environment;
}

async function executeFlow({ context, page, baseURL, evidenceDir, flow, allowedOrigins, profileId, secrets, observations, videos }) {
	const timeout = Math.min(finitePositive(flow.timeoutMs) ?? 15_000, 60_000);
	page.setDefaultTimeout(timeout);
	page.setDefaultNavigationTimeout(timeout);
	const popups = new Map();
	let activeIndex = 0;
	let popupCaptureArmed = false;
	let capturedPopup;
	let unexpectedPopupError;
	const readinessTrackers = new Map();
	const readinessFor = (candidate) => {
		if (!readinessTrackers.has(candidate)) readinessTrackers.set(candidate, createPageReadinessTracker(candidate));
		return readinessTrackers.get(candidate);
	};
	readinessFor(page);
	const onContextPage = (candidate) => {
		if (candidate === page) return;
		if (popupCaptureArmed && !capturedPopup) {
			readinessFor(candidate);
			capturedPopup = candidate;
			return;
		}
		videos.push({ name: `discarded-popup-${videos.length}.webm`, video: candidate.video(), discard: true });
		unexpectedPopupError ??= flowError(profileId, activeIndex, "unexpected popup opened; use openPopup to declare it");
		void candidate.close().catch(() => {});
	};
	context.on("page", onContextPage);
	try {
	for (let index = 0; index < flow.steps.length; index += 1) {
		activeIndex = index;
		const step = flow.steps[index];
		if (!isObject(step) || typeof step.action !== "string") throw flowError(profileId, index, "action is missing");
		if ((step.expectResponse !== undefined || step.expectDialog !== undefined)
			&& !["click", "doubleClick", "press", "check", "uncheck", "selectOption"].includes(step.action)) {
			throw flowError(profileId, index, "response and dialog expectations require a triggering interaction");
		}
		const { scope, ownerPage } = await resolveStepTarget({ page, popups, step, allowedOrigins, profileId, index });
		const locator = step.locator === undefined ? undefined : resolveLocator(scope, step.locator, profileId, index);
		switch (step.action) {
			case "goto": {
				const target = typeof step.url === "string" ? step.url : step.path;
				if (typeof target !== "string") throw flowError(profileId, index, "goto requires url or path");
				const url = new URL(target, baseURL);
				if (url.username || url.password || !allowedOrigins.includes(url.origin)) throw flowError(profileId, index, "goto target is outside allowedOrigins");
				await scope.goto(url.href, { waitUntil: validWaitUntil(step.waitUntil) });
				break;
			}
			case "reload":
				if (scope !== ownerPage) throw flowError(profileId, index, "reload is not supported for frame targets");
				await ownerPage.reload({ waitUntil: validWaitUntil(step.waitUntil) });
				break;
			case "click": await executeExpectedInteraction({ ownerPage, step, allowedOrigins, timeout, profileId, index, action: () => requireLocator(locator, profileId, index).click({ delay: CLICK_VIDEO_DELAY_MS }) }); break;
			case "doubleClick": await executeExpectedInteraction({ ownerPage, step, allowedOrigins, timeout, profileId, index, action: () => requireLocator(locator, profileId, index).dblclick({ delay: CLICK_VIDEO_DELAY_MS }) }); break;
			case "hover": await requireLocator(locator, profileId, index).hover(); break;
			case "fill":
				if (typeof step.value !== "string") throw flowError(profileId, index, "fill requires a string value");
				await requireLocator(locator, profileId, index).fill(step.value);
				break;
			case "press":
				if (typeof step.key !== "string" || step.key.length > 80) throw flowError(profileId, index, "press requires a valid key");
				await executeExpectedInteraction({ ownerPage, step, allowedOrigins, timeout, profileId, index, action: () => requireLocator(locator, profileId, index).press(step.key) });
				break;
			case "check": await executeExpectedInteraction({ ownerPage, step, allowedOrigins, timeout, profileId, index, action: () => requireLocator(locator, profileId, index).check() }); break;
			case "uncheck": await executeExpectedInteraction({ ownerPage, step, allowedOrigins, timeout, profileId, index, action: () => requireLocator(locator, profileId, index).uncheck() }); break;
			case "selectOption":
				if (typeof step.value !== "string" && !isStringArray(step.value)) throw flowError(profileId, index, "selectOption requires a string or string array");
				await executeExpectedInteraction({ ownerPage, step, allowedOrigins, timeout, profileId, index, action: () => requireLocator(locator, profileId, index).selectOption(step.value) });
				break;
			case "dragTo": {
				const source = requireLocator(locator, profileId, index);
				const destination = resolveLocator(scope, step.dropTarget, profileId, index);
				const options = {};
				if (step.sourcePosition !== undefined) options.sourcePosition = resolvePoint(step.sourcePosition, profileId, index, "sourcePosition");
				if (step.dropPosition !== undefined) options.targetPosition = resolvePoint(step.dropPosition, profileId, index, "dropPosition");
				const replayPoints = await Promise.all([
					source.evaluate((element, position) => {
						const rect = element.getBoundingClientRect();
						return { x: (rect.left ?? rect.x) + (position?.x ?? rect.width / 2), y: (rect.top ?? rect.y) + (position?.y ?? rect.height / 2) };
					}, options.sourcePosition),
					destination.evaluate((element, position) => {
						const rect = element.getBoundingClientRect();
						return { x: (rect.left ?? rect.x) + (position?.x ?? rect.width / 2), y: (rect.top ?? rect.y) + (position?.y ?? rect.height / 2) };
					}, options.targetPosition),
				]);
				await source.evaluate((element, points) => {
					element.dispatchEvent(new CustomEvent("pi-browser-qa-drag-replay", { bubbles: true, composed: true, detail: { points } }));
				}, replayPoints);
				await source.dragTo(destination, options);
				await ownerPage.waitForTimeout(DRAG_VIDEO_REPLAY_MS + UI_READY_POLL_MS);
				break;
			}
			case "uploadFiles": {
				const files = decodeUploadFiles(step.files, profileId, index);
				await requireLocator(locator, profileId, index).setInputFiles(files);
				break;
			}
			case "openPopup": {
				if (!isSafeName(step.name)) throw flowError(profileId, index, "openPopup requires a safe name");
				if (popups.has(step.name)) throw flowError(profileId, index, `popup name is duplicated: ${step.name}`);
				if (popups.size >= MAX_POPUPS) throw flowError(profileId, index, `openPopup supports at most ${MAX_POPUPS} popups`);
				popupCaptureArmed = true;
				capturedPopup = undefined;
				const popupPromise = ownerPage.waitForEvent("popup", { timeout });
				let popup;
				let popupVideo;
				try {
					[, popup] = await Promise.all([requireLocator(locator, profileId, index).click({ delay: CLICK_VIDEO_DELAY_MS }), popupPromise]);
					popup.setDefaultTimeout(timeout);
					popup.setDefaultNavigationTimeout(timeout);
					popupVideo = { name: `video-popup-${step.name}.webm`, video: popup.video(), discard: false };
					videos.push(popupVideo);
					await popup.waitForLoadState("domcontentloaded", { timeout });
					await waitForUiReady({
						scope: popup,
						tracker: readinessFor(popup),
						timeout,
						failure: () => flowError(profileId, index, "popup did not finish loading"),
					});
					const origin = assertSameOriginPage(popup, ownerPage, allowedOrigins, profileId, index, "popup");
					await popup.bringToFront();
					// A static popup may not repaint after Playwright starts its screencast, leaving the video blank.
					await popup.screenshot({ type: "png" });
					await popup.waitForTimeout(POPUP_VIDEO_SETTLE_MS);
					popups.set(step.name, { page: popup, origin });
				} catch (error) {
					popup ??= capturedPopup;
					if (popup && !popupVideo) {
						popupVideo = { name: `discarded-popup-${videos.length}.webm`, video: popup.video(), discard: true };
						videos.push(popupVideo);
					}
					if (popupVideo) popupVideo.discard = true;
					await popup?.close().catch(() => {});
					throw error;
				} finally {
					popupCaptureArmed = false;
					capturedPopup = undefined;
				}
				break;
			}
			case "download": {
				await executeDownload({ ownerPage, locator: requireLocator(locator, profileId, index), step, evidenceDir, allowedOrigins, timeout, profileId, index, secrets });
				break;
			}
			case "wheel": {
				const deltaX = optionalFiniteNumber(step.deltaX, 0, profileId, index, "wheel deltaX");
				const deltaY = optionalFiniteNumber(step.deltaY, 0, profileId, index, "wheel deltaY");
				if (deltaX === 0 && deltaY === 0) throw flowError(profileId, index, "wheel requires a non-zero deltaX or deltaY");
				if (locator) await locator.hover();
				await ownerPage.mouse.wheel(deltaX, deltaY);
				break;
			}
			case "evaluate":
				await executeSafeEvaluation({ page: scope, locator, step, profileId, index, observations });
				break;
			case "waitFor": await requireLocator(locator, profileId, index).waitFor({ state: validLocatorState(step.state) }); break;
			case "waitForTimeout":
				if (!finitePositive(step.timeoutMs) || step.timeoutMs > 5_000) throw flowError(profileId, index, "waitForTimeout must be between 1 and 5000 ms");
				await ownerPage.waitForTimeout(step.timeoutMs);
				break;
			case "assertVisible": {
				const target = requireLocator(locator, profileId, index);
				await retryAssertion({ page: ownerPage, timeout, profileId, index, reason: "expected locator to be visible", check: () => target.isVisible() });
				break;
			}
			case "assertHidden": {
				const target = requireLocator(locator, profileId, index);
				await retryAssertion({ page: ownerPage, timeout, profileId, index, reason: "expected locator to be hidden", check: () => target.isHidden() });
				break;
			}
			case "assertEnabled": {
				const target = requireLocator(locator, profileId, index);
				await retryAssertion({ page: ownerPage, timeout, profileId, index, reason: "expected locator to be enabled", check: () => target.isEnabled() });
				break;
			}
			case "assertDisabled": {
				const target = requireLocator(locator, profileId, index);
				await retryAssertion({ page: ownerPage, timeout, profileId, index, reason: "expected locator to be disabled", check: () => target.isDisabled() });
				break;
			}
			case "assertChecked": {
				const target = requireLocator(locator, profileId, index);
				await retryAssertion({ page: ownerPage, timeout, profileId, index, reason: "expected locator to be checked", check: () => target.isChecked() });
				break;
			}
			case "assertUnchecked": {
				const target = requireLocator(locator, profileId, index);
				await retryAssertion({ page: ownerPage, timeout, profileId, index, reason: "expected locator to be unchecked", check: async () => !(await target.isChecked()) });
				break;
			}
			case "assertText": {
				const matches = expectedStringMatcher(step, profileId, index, "text");
				const target = requireLocator(locator, profileId, index);
				await retryAssertion({
					page: ownerPage, timeout, profileId, index, reason: "text assertion failed",
					check: async () => matches((await target.textContent()) ?? ""),
				});
				break;
			}
			case "assertValue": {
				const matches = expectedStringMatcher(step, profileId, index, "value");
				const target = requireLocator(locator, profileId, index);
				await retryAssertion({
					page: ownerPage, timeout, profileId, index, reason: "value assertion failed",
					check: async () => matches(await target.inputValue()),
				});
				break;
			}
			case "assertAttribute": {
				if (typeof step.attribute !== "string" || !ATTRIBUTE_NAME.test(step.attribute)) {
					throw flowError(profileId, index, "assertAttribute requires a valid attribute name");
				}
				const matches = expectedStringMatcher(step, profileId, index, "attribute");
				const target = requireLocator(locator, profileId, index);
				await retryAssertion({
					page: ownerPage, timeout, profileId, index, reason: "attribute assertion failed",
					check: async () => {
						const actual = await target.getAttribute(step.attribute);
						return actual !== null && matches(actual);
					},
				});
				break;
			}
			case "assertCount": {
				if (!Number.isInteger(step.equals) || step.equals < 0) throw flowError(profileId, index, "assertCount requires a non-negative integer equals");
				const target = requireLocator(locator, profileId, index);
				await retryAssertion({
					page: ownerPage, timeout, profileId, index, reason: "locator count assertion failed",
					check: async () => (await target.count()) === step.equals,
				});
				break;
			}
			case "assertDOMMetric": {
				if (typeof step.metric !== "string") throw flowError(profileId, index, "assertDOMMetric requires metric");
				const initialMetrics = await collectDomMetrics(scope, locator);
				if (!Object.prototype.hasOwnProperty.call(initialMetrics, step.metric)) {
					throw flowError(profileId, index, `unsupported DOM metric: ${step.metric}`);
				}
				const matches = numericComparisonMatcher(step, profileId, index);
				await retryAssertion({
					page: ownerPage, timeout, profileId, index, reason: `${step.metric} assertion failed`,
					check: async () => matches((await collectDomMetrics(scope, locator))[step.metric]),
				});
				break;
			}
			case "assertURL": {
				const matches = expectedStringMatcher(step, profileId, index, "URL");
				await retryAssertion({ page: ownerPage, timeout, profileId, index, reason: "URL assertion failed", check: () => matches(scope.url()) });
				break;
			}
			case "authRejectedIf": {
				const urlRejected = typeof step.urlIncludes === "string" && scope.url().includes(step.urlIncludes);
				const locatorRejected = locator ? await locator.isVisible().catch(() => false) : false;
				if (!urlRejected && !locatorRejected) break;
				throw new QaStatusError("QA_AUTH_UPDATE_REQUIRED", "application rejected or expired the configured authentication", EXIT_AUTH_UPDATE_REQUIRED, profileId);
			}
			case "screenshot": {
				const name = typeof step.name === "string" ? step.name : `step-${index + 1}`;
				if (!isSafeName(name)) throw flowError(profileId, index, "screenshot name is invalid");
				await assertBrowserDoesNotExposeSecrets(context, page, secrets, profileId);
				await ownerPage.screenshot({ path: path.join(evidenceDir, `${name}.png`), fullPage: step.fullPage !== false });
				break;
			}
			default: throw flowError(profileId, index, `unsupported action: ${step.action}`);
		}
		if (UI_READY_ACTIONS.has(step.action)) {
			await waitForUiReady({
				scope,
				tracker: readinessFor(ownerPage),
				timeout,
				failure: () => flowError(profileId, index, "page did not finish loading"),
			});
		}
		if (unexpectedPopupError) throw unexpectedPopupError;
		await assertBrowserDoesNotExposeSecrets(context, page, secrets, profileId);
	}
	} finally {
		context.off("page", onContextPage);
		for (const tracker of readinessTrackers.values()) tracker.dispose();
	}
}

function createPageReadinessTracker(page) {
	const pendingRequests = new Set();
	const onRequest = (request) => pendingRequests.add(request);
	const onRequestDone = (request) => pendingRequests.delete(request);
	page.on("request", onRequest);
	page.on("requestfinished", onRequestDone);
	page.on("requestfailed", onRequestDone);
	return {
		page,
		pendingRequests,
		dispose() {
			page.off("request", onRequest);
			page.off("requestfinished", onRequestDone);
			page.off("requestfailed", onRequestDone);
		},
	};
}

async function waitForUiReady({ scope, tracker, timeout, failure }) {
	const deadline = Date.now() + timeout;
	try {
		await scope.waitForLoadState("domcontentloaded", { timeout });
	} catch {
		throw failure();
	}
	while (true) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw failure();
		const hasBusyIndicator = await hasVisibleBusyIndicator(scope);
		if (tracker.pendingRequests.size === 0 && !hasBusyIndicator) {
			await tracker.page.waitForTimeout(Math.min(UI_READY_SETTLE_MS, remaining));
			const stillBusy = await hasVisibleBusyIndicator(scope);
			if (tracker.pendingRequests.size === 0 && !stillBusy) return;
			continue;
		}
		await tracker.page.waitForTimeout(Math.min(UI_READY_POLL_MS, remaining));
	}
}

async function hasVisibleBusyIndicator(scope) {
	try {
		return await scope.locator(VISIBLE_BUSY_SELECTOR).count() > 0;
	} catch {
		// A navigation can replace the execution context between readiness polls.
		return true;
	}
}

async function resolveStepTarget({ page, popups, step, allowedOrigins, profileId, index }) {
	if (step.target === undefined || (isObject(step.target) && step.target.type === "main")) {
		return { scope: page, ownerPage: page };
	}
	if (!isObject(step.target)) throw flowError(profileId, index, "target must be an object");
	if (step.target.type === "popup") {
		if (!isSafeName(step.target.name) || !popups.has(step.target.name)) throw flowError(profileId, index, "popup target is missing or unknown");
		const record = popups.get(step.target.name);
		const popup = record.page;
		if (popup.isClosed()) throw flowError(profileId, index, "popup target is closed");
		assertPageOrigin(popup, record.origin, allowedOrigins, profileId, index, "popup target");
		return { scope: popup, ownerPage: popup };
	}
	if (step.target.type === "frame") {
		const popupRecord = step.target.page === undefined ? undefined : popups.get(step.target.page);
		const ownerPage = step.target.page === undefined ? page : popupRecord?.page;
		if (!ownerPage || ownerPage.isClosed() || (step.target.page !== undefined && !isSafeName(step.target.page))) {
			throw flowError(profileId, index, "frame target page is missing or unknown");
		}
		const frameLocator = resolveLocator(ownerPage, step.target.locator, profileId, index);
		const handle = await frameLocator.elementHandle();
		const frame = await handle?.contentFrame();
		if (!frame) throw flowError(profileId, index, "frame target did not resolve to an iframe");
		let origin;
		try { origin = await frame.evaluate(() => location.origin); } catch { /* rejected below */ }
		let ownerOrigin;
		try { ownerOrigin = new URL(ownerPage.url()).origin; } catch { /* rejected below */ }
		if (!allowedOrigins.includes(origin) || origin !== ownerOrigin) throw flowError(profileId, index, "frame target must be same-origin with its page");
		return { scope: frame, ownerPage };
	}
	throw flowError(profileId, index, "target type must be main, popup, or frame");
}

function assertSameOriginPage(page, ownerPage, allowedOrigins, profileId, index, label) {
	let ownerOrigin;
	try { ownerOrigin = new URL(ownerPage.url()).origin; } catch { /* rejected below */ }
	return assertPageOrigin(page, ownerOrigin, allowedOrigins, profileId, index, label);
}

function assertPageOrigin(page, expectedOrigin, allowedOrigins, profileId, index, label) {
	try {
		const url = new URL(page.url());
		if (!url.username && !url.password && allowedOrigins.includes(url.origin) && url.origin === expectedOrigin) return url.origin;
	} catch { /* rejected below */ }
	throw flowError(profileId, index, `${label} must be same-origin with its opener`);
}

async function executeExpectedInteraction({ ownerPage, step, allowedOrigins, timeout, profileId, index, action }) {
	const watchers = [];
	try {
		if (step.expectResponse !== undefined) watchers.push(createResponseWatcher(ownerPage, step.expectResponse, allowedOrigins, timeout, profileId, index));
		if (step.expectDialog !== undefined) watchers.push(createDialogWatcher(ownerPage, step.expectDialog, timeout, profileId, index));
		await Promise.all([action(), ...watchers.map((watcher) => watcher.promise)]);
	} finally {
		for (const watcher of watchers) watcher.cancel();
	}
}

function createResponseWatcher(page, expectation, allowedOrigins, timeout, profileId, index) {
	if (!isObject(expectation)
		|| typeof expectation.path !== "string"
		|| !expectation.path.startsWith("/")
		|| expectation.path.startsWith("//")
		|| /[?#\\]/.test(expectation.path)
		|| !HTTP_METHODS.has(expectation.method)
		|| !Number.isInteger(expectation.status)
		|| expectation.status < 100
		|| expectation.status > 599) {
		throw flowError(profileId, index, "expectResponse requires exact path, method, and status");
	}
	let settled = false;
	let settle;
	const matchingRequests = new Set();
	const promise = new Promise((resolve, reject) => {
		settle = { resolve, reject };
	});
	const cleanup = () => {
		clearTimeout(timer);
		page.off("request", onRequest);
		page.off("response", onResponse);
	};
	const finish = (error) => {
		if (settled) return;
		settled = true;
		cleanup();
		if (error) settle.reject(error);
		else settle.resolve();
	};
	const onRequest = (request) => {
		try {
			const url = new URL(request.url());
			if (!allowedOrigins.includes(url.origin)
				|| url.pathname !== expectation.path
				|| request.method() !== expectation.method) return;
			matchingRequests.add(request);
		} catch { /* unrelated request */ }
	};
	const onResponse = (response) => {
		try {
			if (!matchingRequests.has(response.request()) || response.status() !== expectation.status) return;
			finish();
		} catch { /* unrelated response */ }
	};
	const timer = setTimeout(() => finish(flowError(profileId, index, "expected response was not observed before timeout")), timeout);
	page.on("request", onRequest);
	page.on("response", onResponse);
	return { promise, cancel: () => finish() };
}

function createDialogWatcher(page, expectation, timeout, profileId, index) {
	if (!isObject(expectation)
		|| !DIALOG_TYPES.has(expectation.type)
		|| !isObject(expectation.message)
		|| typeof expectation.accept !== "boolean") {
		throw flowError(profileId, index, "expectDialog requires type, message matcher, and accept");
	}
	const matches = expectedStringMatcher(expectation.message, profileId, index, "dialog message");
	let settled = false;
	let settle;
	const promise = new Promise((resolve, reject) => {
		settle = { resolve, reject };
	});
	const cleanup = () => {
		clearTimeout(timer);
		page.off("dialog", onDialog);
	};
	const finish = (error) => {
		if (settled) return;
		settled = true;
		cleanup();
		if (error) settle.reject(error);
		else settle.resolve();
	};
	const onDialog = async (dialog) => {
		const matched = dialog.type() === expectation.type && matches(dialog.message());
		try {
			if (matched && expectation.accept) await dialog.accept();
			else await dialog.dismiss();
			finish(matched ? undefined : flowError(profileId, index, "native dialog did not match expectation"));
		} catch {
			finish(flowError(profileId, index, "native dialog could not be handled"));
		}
	};
	const timer = setTimeout(() => finish(flowError(profileId, index, "expected native dialog was not observed before timeout")), timeout);
	page.on("dialog", onDialog);
	return { promise, cancel: () => finish() };
}

function resolvePoint(value, profileId, index, label) {
	if (!isObject(value)
		|| typeof value.x !== "number" || !Number.isFinite(value.x) || value.x < 0 || value.x > 100_000
		|| typeof value.y !== "number" || !Number.isFinite(value.y) || value.y < 0 || value.y > 100_000) {
		throw flowError(profileId, index, `${label} requires bounded non-negative x and y`);
	}
	return { x: value.x, y: value.y };
}

function decodeUploadFiles(value, profileId, index) {
	if (!Array.isArray(value) || value.length > MAX_UPLOAD_FILES) {
		throw flowError(profileId, index, `uploadFiles requires an array of at most ${MAX_UPLOAD_FILES} files`);
	}
	let totalBytes = 0;
	return value.map((file) => {
		if (!isObject(file)
			|| typeof file.name !== "string" || file.name.length === 0 || file.name.length > 128 || /[\\/\0-\x1f]/.test(file.name)
			|| typeof file.mimeType !== "string" || file.mimeType.length > 128 || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(file.mimeType)
			|| typeof file.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) {
			throw flowError(profileId, index, "uploadFiles entries require a safe name, MIME type, and canonical base64");
		}
		const buffer = Buffer.from(file.base64, "base64");
		if (buffer.toString("base64") !== file.base64 || buffer.length > MAX_UPLOAD_FILE_BYTES) {
			throw flowError(profileId, index, `uploadFiles entries may not exceed ${MAX_UPLOAD_FILE_BYTES} bytes`);
		}
		totalBytes += buffer.length;
		if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) throw flowError(profileId, index, `uploadFiles total may not exceed ${MAX_UPLOAD_TOTAL_BYTES} bytes`);
		return { name: file.name, mimeType: file.mimeType, buffer };
	});
}

async function executeDownload({ ownerPage, locator, step, evidenceDir, allowedOrigins, timeout, profileId, index, secrets }) {
	if (!isObject(step.filename)) throw flowError(profileId, index, "download requires a filename matcher");
	const filenameMatches = expectedStringMatcher(step.filename, profileId, index, "download filename");
	const maxBytes = step.maxBytes === undefined ? DEFAULT_DOWNLOAD_MAX_BYTES : step.maxBytes;
	if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DOWNLOAD_BYTES) {
		throw flowError(profileId, index, `download maxBytes must be between 1 and ${MAX_DOWNLOAD_BYTES}`);
	}
	if (step.retain !== undefined && typeof step.retain !== "boolean") throw flowError(profileId, index, "download retain must be boolean");
	if (step.retain === true && !isSafeName(step.name)) throw flowError(profileId, index, "retained download requires a safe name");
	const retained = step.retain === true ? path.join(evidenceDir, `download-${step.name}.bin`) : undefined;
	if (retained && fs.existsSync(retained)) throw flowError(profileId, index, `retained download name is duplicated: ${step.name}`);
	const downloadPromise = ownerPage.waitForEvent("download", { timeout });
	const [, download] = await Promise.all([locator.click({ delay: CLICK_VIDEO_DELAY_MS }), downloadPromise]);
	try {
		const url = new URL(download.url());
		if (!allowedOrigins.includes(url.origin)) throw flowError(profileId, index, "download is outside allowedOrigins");
	} catch (error) {
		await download.cancel().catch(() => {});
		if (error instanceof QaStatusError) throw error;
		throw flowError(profileId, index, "download is outside allowedOrigins");
	}
	if (!filenameMatches(download.suggestedFilename())) {
		await download.cancel().catch(() => {});
		throw flowError(profileId, index, "download filename did not match expectation");
	}
	const temporary = path.join(evidenceDir, `.download-${index + 1}.tmp`);
	try {
		await saveDownloadWithLimit(download, temporary, maxBytes, profileId, index);
		assertFileDoesNotExposeSecrets(temporary, secrets, profileId);
		if (retained) {
			fs.renameSync(temporary, retained);
			fs.chmodSync(retained, 0o600);
		}
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

async function saveDownloadWithLimit(download, destination, maxBytes, profileId, index) {
	let completed = false;
	let failure;
	const save = download.saveAs(destination).then(
		() => { completed = true; },
		(error) => { completed = true; failure = error; },
	);
	let exceeded = false;
	while (!completed) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		if (!fs.existsSync(destination) || fs.statSync(destination).size <= maxBytes) continue;
		exceeded = true;
		await download.cancel().catch(() => {});
		break;
	}
	await save;
	if (exceeded || (fs.existsSync(destination) && fs.statSync(destination).size > maxBytes)) {
		throw flowError(profileId, index, "download exceeded maxBytes");
	}
	if (failure) throw flowError(profileId, index, "download could not be saved");
}

function assertFileDoesNotExposeSecrets(file, secrets, profileId) {
	if (secrets.length === 0) return;
	const bytes = fs.readFileSync(file);
	if (!secrets.some((secret) => secret && bytes.includes(Buffer.from(secret)))) return;
	const error = new QaStatusError("QA_RUN_FAILED", "configured authentication appeared in a retained download; retained evidence was discarded", 1, profileId);
	error.suppressEvidence = true;
	throw error;
}

async function executeSafeEvaluation({ page, locator, step, profileId, index, observations }) {
	switch (step.operation) {
		case "scrollTo": {
			const position = {
				x: scrollPosition(step.x, profileId, index, "evaluate scrollTo x"),
				y: scrollPosition(step.y, profileId, index, "evaluate scrollTo y"),
			};
			if (position.x === undefined && position.y === undefined) throw flowError(profileId, index, "evaluate scrollTo requires x or y");
			if (locator) {
				await locator.evaluate((element, next) => {
					const maxX = Math.max(0, element.scrollWidth - element.clientWidth);
					const maxY = Math.max(0, element.scrollHeight - element.clientHeight);
					const x = next.x === "max" ? maxX : next.x ?? element.scrollLeft;
					const y = next.y === "max" ? maxY : next.y ?? element.scrollTop;
					element.scrollTo(x, y);
				}, position);
			} else {
				await page.evaluate((next) => {
					const root = document.scrollingElement ?? document.documentElement;
					const maxX = Math.max(0, root.scrollWidth - window.innerWidth);
					const maxY = Math.max(0, root.scrollHeight - window.innerHeight);
					const x = next.x === "max" ? maxX : next.x ?? window.scrollX;
					const y = next.y === "max" ? maxY : next.y ?? window.scrollY;
					window.scrollTo(x, y);
				}, position);
			}
			break;
		}
		case "scrollBy": {
			const deltaX = optionalFiniteNumber(step.deltaX, 0, profileId, index, "evaluate scrollBy deltaX");
			const deltaY = optionalFiniteNumber(step.deltaY, 0, profileId, index, "evaluate scrollBy deltaY");
			if (deltaX === 0 && deltaY === 0) throw flowError(profileId, index, "evaluate scrollBy requires a non-zero deltaX or deltaY");
			if (locator) await locator.evaluate((element, delta) => element.scrollBy(delta.x, delta.y), { x: deltaX, y: deltaY });
			else await page.evaluate((delta) => window.scrollBy(delta.x, delta.y), { x: deltaX, y: deltaY });
			break;
		}
		case "metrics": {
			const name = step.name === undefined ? `metrics-${index + 1}` : step.name;
			if (!isSafeName(name)) throw flowError(profileId, index, "evaluate metrics name is invalid");
			if (observations.some((entry) => entry.name === name)) throw flowError(profileId, index, `evaluate metrics name is duplicated: ${name}`);
			observations.push({ name, step: index + 1, value: await collectDomMetrics(page, locator) });
			break;
		}
		default:
			throw flowError(profileId, index, "evaluate requires operation scrollTo, scrollBy, or metrics; executable JavaScript is not allowed");
	}
}

async function collectDomMetrics(page, locator) {
	if (locator) {
		return locator.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return {
				scrollLeft: element.scrollLeft,
				scrollTop: element.scrollTop,
				scrollWidth: element.scrollWidth,
				scrollHeight: element.scrollHeight,
				clientWidth: element.clientWidth,
				clientHeight: element.clientHeight,
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
			};
		});
	}
	return page.evaluate(() => {
		const root = document.scrollingElement ?? document.documentElement;
		return {
			scrollX: window.scrollX,
			scrollY: window.scrollY,
			scrollWidth: root.scrollWidth,
			scrollHeight: root.scrollHeight,
			clientWidth: root.clientWidth,
			clientHeight: root.clientHeight,
			viewportWidth: window.innerWidth,
			viewportHeight: window.innerHeight,
		};
	});
}

function scrollPosition(value, profileId, index, label) {
	if (value === undefined || value === "max") return value;
	return finiteNumber(value, profileId, index, label);
}

function optionalFiniteNumber(value, fallback, profileId, index, label) {
	return value === undefined ? fallback : finiteNumber(value, profileId, index, label);
}

function finiteNumber(value, profileId, index, label) {
	if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_SCROLL_DISTANCE) {
		throw flowError(profileId, index, `${label} must be a finite number between -${MAX_SCROLL_DISTANCE} and ${MAX_SCROLL_DISTANCE}`);
	}
	return value;
}

function numericComparisonMatcher(step, profileId, index) {
	const comparisons = ["equals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"]
		.filter((key) => typeof step[key] === "number" && Number.isFinite(step[key]));
	if (comparisons.length !== 1) throw flowError(profileId, index, "assertDOMMetric requires exactly one numeric comparator");
	const key = comparisons[0];
	const expected = step[key];
	switch (key) {
		case "equals": return (actual) => actual === expected;
		case "greaterThan": return (actual) => actual > expected;
		case "greaterThanOrEqual": return (actual) => actual >= expected;
		case "lessThan": return (actual) => actual < expected;
		case "lessThanOrEqual": return (actual) => actual <= expected;
	}
}

function resolveLocator(page, value, profileId, index) {
	if (!isObject(value)) throw flowError(profileId, index, "locator must be an object");
	const exact = value.exact === true;
	if (typeof value.testId === "string") return page.getByTestId(value.testId);
	if (typeof value.role === "string") return page.getByRole(value.role, typeof value.name === "string" ? { name: value.name, exact } : undefined);
	if (typeof value.label === "string") return page.getByLabel(value.label, { exact });
	if (typeof value.placeholder === "string") return page.getByPlaceholder(value.placeholder, { exact });
	if (typeof value.text === "string") return page.getByText(value.text, { exact });
	if (typeof value.css === "string") return page.locator(value.css);
	throw flowError(profileId, index, "locator requires testId, role, label, placeholder, text, or css");
}

function requireLocator(locator, profileId, index) {
	if (!locator) throw flowError(profileId, index, "action requires locator");
	return locator;
}

function expectedStringMatcher(step, profileId, index, label) {
	const hasEquals = typeof step.equals === "string";
	const hasIncludes = typeof step.includes === "string";
	if (hasEquals === hasIncludes) throw flowError(profileId, index, `${label} assertion requires exactly one of equals or includes`);
	return hasEquals ? (actual) => actual === step.equals : (actual) => actual.includes(step.includes);
}

async function retryAssertion({ page, timeout, profileId, index, reason, check }) {
	const deadline = Date.now() + timeout;
	while (true) {
		try {
			if (await check()) return;
		} catch {
			// Dynamic UI may temporarily detach or replace the target; retry until the assertion deadline.
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw flowError(profileId, index, reason);
		await page.waitForTimeout(Math.min(ASSERTION_POLL_INTERVAL_MS, remaining));
	}
}

function flowError(profileId, index, reason) {
	return new QaStatusError("QA_RUN_FAILED", `flow step ${index + 1}: ${reason}`, 1, profileId);
}

function validWaitUntil(value) {
	return ["commit", "domcontentloaded", "load", "networkidle"].includes(value) ? value : "load";
}

function validLocatorState(value) {
	return ["attached", "detached", "visible", "hidden"].includes(value) ? value : "visible";
}

function isStringArray(value) {
	return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
}

async function contextOptionsForAuth({ cwd, profileId, profile, allowedOrigins }) {
	const auth = profile.auth;
	if (auth.type === "none") return {};
	if (auth.type === "storageState") {
		if (typeof auth.path !== "string") throw authError(profileId, "storageState path is missing");
		const statePath = resolveExistingPrivateFile(cwd, auth.path, "storageState");
		return { storageState: filteredStorageState(statePath, allowedOrigins, profileId) };
	}
	if (auth.type === "form") {
		return {};
	}
	if (!["cookie", "localStorage", "sessionStorage", "bearer"].includes(auth.type)) {
		throw authError(profileId, `unsupported auth type: ${auth.type}`);
	}
	return {};
}

async function applyFormAuth(page, auth, allowedOrigins, profileId) {
	if (auth.type !== "form") return;
	if (typeof auth.loginUrl !== "string" || !isAllowedUrl(auth.loginUrl, allowedOrigins)) {
		throw authError(profileId, "form loginUrl is missing or outside allowedOrigins");
	}
	if (!Array.isArray(auth.fields) || auth.fields.length === 0 || typeof auth.submitSelector !== "string") {
		throw authError(profileId, "form fields or submitSelector are missing");
	}
	const readinessTracker = createPageReadinessTracker(page);
	try {
		const timeout = Math.min(finitePositive(auth.timeoutMs) ?? 15_000, 60_000);
		page.setDefaultTimeout(timeout);
		page.setDefaultNavigationTimeout(timeout);
		await page.goto(auth.loginUrl, { timeout });
		await waitForUiReady({
			scope: page,
			tracker: readinessTracker,
			timeout,
			failure: () => authError(profileId, "form page did not finish loading"),
		});
		for (const field of auth.fields) {
			if (!isObject(field) || typeof field.selector !== "string" || typeof field.value !== "string") {
				throw authError(profileId, "form fields must contain selector/value strings");
			}
			await page.locator(field.selector).fill(field.value);
			await page.waitForTimeout(FORM_VIDEO_STEP_DELAY_MS);
		}
		await page.locator(auth.submitSelector).click({ delay: CLICK_VIDEO_DELAY_MS });
		if (isObject(auth.success) && typeof auth.success.url === "string") await page.waitForURL(auth.success.url, { timeout });
		if (isObject(auth.success) && typeof auth.success.selector === "string") {
			await page.locator(auth.success.selector).waitFor({ timeout, state: validLocatorState(auth.success.state) });
		}
		if (!isObject(auth.success) || (typeof auth.success.url !== "string" && typeof auth.success.selector !== "string")) {
			throw authError(profileId, "form success.url or success.selector is required");
		}
		await waitForUiReady({
			scope: page,
			tracker: readinessTracker,
			timeout,
			failure: () => authError(profileId, "authenticated page did not finish loading"),
		});
	} catch (error) {
		if (error instanceof QaStatusError) throw error;
		throw authError(profileId, "form login was rejected or did not reach the configured success condition");
	} finally {
		readinessTracker.dispose();
	}
}

async function applyContextAuth(context, auth, allowedOrigins, baseURL, profileId) {
	if (auth.type === "cookie") {
		if (!Array.isArray(auth.cookies) || auth.cookies.length === 0) throw authError(profileId, "cookie auth requires cookies");
		for (const cookie of auth.cookies) {
			if (!isObject(cookie) || typeof cookie.name !== "string" || typeof cookie.value !== "string") throw authError(profileId, "invalid cookie auth entry");
			if (!cookieAllowed(cookie, allowedOrigins)) throw authError(profileId, "cookie auth domain is outside allowedOrigins");
		}
		await context.addCookies(auth.cookies);
	}
	if (auth.type === "localStorage" || auth.type === "sessionStorage") {
		const originUrl = typeof auth.origin === "string" ? auth.origin : baseURL;
		if (!isAllowedUrl(originUrl, allowedOrigins) || !isObject(auth.entries)) throw authError(profileId, `${auth.type} auth is invalid`);
		const origin = new URL(originUrl).origin;
		const storage = auth.type;
		const entries = Object.entries(auth.entries);
		if (entries.length === 0 || entries.some(([, value]) => typeof value !== "string")) throw authError(profileId, `${auth.type} entries must be non-empty strings`);
		await context.addInitScript(({ expectedOrigin, storageName, values }) => {
			if (location.origin !== expectedOrigin) return;
			const target = storageName === "localStorage" ? localStorage : sessionStorage;
			for (const [key, value] of values) target.setItem(key, value);
		}, { expectedOrigin: origin, storageName: storage, values: entries });
	}
}

async function installOriginGuard(context, allowedOrigins, auth) {
	await context.route("**/*", async (route) => {
		const request = route.request();
		let url;
		try { url = new URL(request.url()); } catch {
			await route.abort("blockedbyclient");
			return;
		}
		if (!isAllowedNetworkUrl(url, allowedOrigins)) {
			await route.abort("blockedbyclient");
			return;
		}
		if (auth.type === "bearer") {
			const headerName = typeof auth.header === "string" && auth.header ? auth.header : "Authorization";
			const prefix = typeof auth.prefix === "string" ? auth.prefix : "Bearer ";
			const headers = Object.fromEntries(Object.entries(request.headers()).filter(([name]) => name.toLowerCase() !== headerName.toLowerCase()));
			await route.continue({ headers: { ...headers, [headerName]: `${prefix}${auth.token}` } });
			return;
		}
		await route.continue();
	});
	if (typeof context.routeWebSocket !== "function") throw new Error("installed Playwright does not support fail-closed WebSocket routing");
	await context.routeWebSocket("**/*", async (webSocket) => {
		let allowed = false;
		try { allowed = isAllowedNetworkUrl(new URL(webSocket.url()), allowedOrigins); } catch { /* blocked */ }
		if (!allowed) {
			await webSocket.close({ code: 1008, reason: "origin blocked by browser QA" });
			return;
		}
		webSocket.connectToServer();
	});
}

function isAllowedNetworkUrl(url, allowedOrigins) {
	if (allowedOrigins.includes(url.origin)) return true;
	if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
	const httpProtocol = url.protocol === "wss:" ? "https:" : "http:";
	return allowedOrigins.includes(`${httpProtocol}//${url.host}`);
}

function filteredStorageState(statePath, allowedOrigins, profileId) {
	let state;
	try {
		state = JSON.parse(fs.readFileSync(statePath, "utf8"));
	} catch {
		throw authError(profileId, "storageState is unreadable or invalid");
	}
	return {
		cookies: Array.isArray(state.cookies) ? state.cookies.filter((cookie) => cookieAllowed(cookie, allowedOrigins)) : [],
		origins: Array.isArray(state.origins) ? state.origins.filter((entry) => isObject(entry) && allowedOrigins.includes(entry.origin)) : [],
	};
}

function cookieAllowed(cookie, allowedOrigins) {
	if (!isObject(cookie)) return false;
	if (typeof cookie.url === "string") return isAllowedUrl(cookie.url, allowedOrigins);
	if (typeof cookie.domain !== "string") return false;
	const domain = cookie.domain.replace(/^\./, "").toLowerCase();
	return allowedOrigins.some((origin) => new URL(origin).hostname.toLowerCase() === domain);
}

function loadPlaywright(cwd) {
	const requireCandidates = [createRequire(path.join(cwd, "package.json")), createRequire(import.meta.url)];
	const cliPath = findExecutable("playwright-cli");
	if (cliPath) requireCandidates.push(createRequire(findPackageJson(fs.realpathSync(cliPath))));
	for (const require of requireCandidates) {
		for (const name of ["playwright", "@playwright/test"]) {
			for (let attempt = 0; ; attempt++) {
				try {
					const module = require(name);
					if (module.chromium) return module;
					break;
				} catch (error) {
					// Windows AV scanners can briefly lock a freshly installed
					// playwright entrypoint; retry the transient case instead of
					// falling through to "playwright unavailable".
					if (attempt < 2 && isTransientFsError(error)) {
						sleepSync(100);
						continue;
					}
					break;
				}
			}
		}
	}
	throw new Error("Playwright is unavailable; install project playwright or @playwright/cli");
}

function isTransientFsError(error) {
	return typeof error?.code === "string" && ["EBUSY", "EPERM", "EACCES"].includes(error.code);
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function findExecutable(name) {
	const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		for (const candidate of names) {
			const file = path.join(directory, candidate);
			if (fs.existsSync(file)) return file;
		}
	}
}

function findPackageJson(startFile) {
	let directory = path.dirname(startFile);
	while (directory !== path.dirname(directory)) {
		const candidate = path.join(directory, "package.json");
		if (fs.existsSync(candidate)) return candidate;
		directory = path.dirname(directory);
	}
	return new URL(import.meta.url);
}

function parseArgs(values) {
	const result = {};
	for (let index = 0; index < values.length; index += 2) {
		const flag = values[index];
		const value = values[index + 1];
		if (!flag?.startsWith("--") || value === undefined) throw new QaStatusError("QA_RUN_FAILED", `invalid argument: ${flag ?? "(missing)"}`, 1);
		const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
		if (!["profile", "flow", "baseUrl", "runId", "runnerTimeoutMs"].includes(key)) throw new QaStatusError("QA_RUN_FAILED", `unknown option: ${flag}`, 1);
		result[key] = value;
	}
	return result;
}

function parseAuthScaffoldArgs(values) {
	const result = {};
	for (let index = 0; index < values.length; index += 2) {
		const flag = values[index];
		const value = values[index + 1];
		if (!flag?.startsWith("--") || value === undefined) throw new QaStatusError("QA_RUN_FAILED", `invalid argument: ${flag ?? "(missing)"}`, 1);
		const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
		if (!["profile", "loginUrl", "baseUrl", "description", "successUrl", "successSelector", "successState", "runnerTimeoutMs"].includes(key)) {
			throw new QaStatusError("QA_RUN_FAILED", `unknown option: ${flag}`, 1);
		}
		if (result[key] !== undefined) throw new QaStatusError("QA_RUN_FAILED", `duplicate option: ${flag}`, 1);
		result[key] = value;
	}
	if (result.description !== undefined) {
		result.description = boundedScaffoldString(result.description, "--description");
		if (result.description.length > 200) throw new QaStatusError("QA_RUN_FAILED", "--description must be no longer than 200 characters", 1);
	}
	return result;
}

function parseRunnerTimeout(value, profileId) {
	if (value === undefined) return DEFAULT_RUNNER_TIMEOUT_MS;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 100 || parsed > MAX_RUNNER_TIMEOUT_MS) {
		throw new QaStatusError(
			"QA_RUN_FAILED",
			`--runner-timeout-ms must be between 100 and ${MAX_RUNNER_TIMEOUT_MS}`,
			1,
			profileId,
		);
	}
	return Math.round(parsed);
}

function createRunnerProgress(workspaceDir) {
	const progressPath = path.join(workspaceDir, "progress.jsonl");
	let lastStage;
	const write = (stage, details = {}) => {
		lastStage = stage;
		if (fs.existsSync(progressPath) && fs.statSync(progressPath).size >= PROGRESS_LOG_MAX_BYTES) {
			fs.writeFileSync(progressPath, "", { mode: 0o600 });
		}
		fs.appendFileSync(progressPath, `${JSON.stringify({ at: new Date().toISOString(), stage, ...details })}\n`, { mode: 0o600 });
	};
	write.lastStage = () => lastStage;
	return write;
}

function terminateRunnerDescendants() {
	// Only a browser launch can leave detached descendants (Playwright spawns
	// the browser as a child of this process), so config and validation
	// failures can skip the process-tree walk entirely.
	if (!runnerMayHaveBrowserChildren) return;
	if (process.platform === "win32") {
		// Detached children are not covered by a POSIX process-group kill. Walk
		// the Windows process tree explicitly so a timed-out Playwright/browser
		// child cannot keep the private QA workspace locked after the runner exits.
		const script = `
$root = ${process.pid}
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$pending = [System.Collections.Generic.Queue[int]]::new()
$pending.Enqueue($root)
$descendants = [System.Collections.Generic.HashSet[int]]::new()
while ($pending.Count -gt 0) {
  $parent = $pending.Dequeue()
foreach ($candidate in $processes) {
    $candidatePid = [int]$candidate.ProcessId
    if ([int]$candidate.ParentProcessId -eq $parent -and $candidatePid -ne $root -and $descendants.Add($candidatePid)) {
      $pending.Enqueue($candidatePid)
    }
  }
}
foreach ($candidatePid in $descendants) {
  Stop-Process -Id $candidatePid -Force -ErrorAction SilentlyContinue
}
`;
		spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			stdio: "ignore",
			// The first powershell.exe launch on a machine can stall for seconds
			// in AV scanning; give the tree walk room to complete so detached
			// browser children cannot outlive the runner and lock the workspace.
			timeout: 5_000,
			windowsHide: true,
		});
		return;
	}
	const snapshot = spawnSync("ps", ["-axo", "pid=,ppid=,pgid="], {
		encoding: "utf8",
		timeout: 1000,
		maxBuffer: 2 * 1024 * 1024,
	});
	if (snapshot.status !== 0 || !snapshot.stdout) return;
	const processes = snapshot.stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter(([pid, parentPid, groupId]) => Number.isInteger(pid) && Number.isInteger(parentPid) && Number.isInteger(groupId))
		.map(([pid, parentPid, groupId]) => ({ pid, parentPid, groupId }));
	const descendants = [];
	const pendingParents = [process.pid];
	for (let index = 0; index < pendingParents.length; index += 1) {
		const parentPid = pendingParents[index];
		for (const candidate of processes) {
			if (candidate.parentPid !== parentPid || descendants.some(({ pid }) => pid === candidate.pid)) continue;
			descendants.push(candidate);
			pendingParents.push(candidate.pid);
		}
	}
	const ownGroup = processes.find(({ pid }) => pid === process.pid)?.groupId;
	for (const { pid, groupId } of descendants) {
		if (pid !== groupId || groupId === ownGroup) continue;
		try {
			process.kill(-groupId, "SIGKILL");
		} catch { /* already gone */ }
	}
	for (const { pid } of descendants) {
		try {
			process.kill(pid, "SIGKILL");
		} catch { /* already gone */ }
	}
}

function sanitizeTraceArchiveInWorker(tracePath, secrets, deadline) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL(import.meta.url), {
			workerData: { operation: "sanitize_trace", tracePath, secrets },
			resourceLimits: { maxOldGenerationSizeMb: 256 },
		});
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(
			() => finish(new RunnerStageTimeoutError("trace_sanitize")),
			Math.max(1, deadline - Date.now()),
		);
		worker.once("message", (message) => {
			if (message?.success === true) finish();
			else finish(new Error(typeof message?.reason === "string" ? message.reason : "trace sanitization failed"));
		});
		worker.once("error", finish);
		worker.once("exit", (code) => {
			if (code !== 0) finish(new Error(`trace sanitizer exited with code ${code}`));
		});
	});
}

async function runStage(progress, stage, deadline, operation, profileId) {
	progress(`${stage}_started`);
	try {
		const result = await withDeadline(operation(), deadline, stage);
		progress(`${stage}_finished`);
		return result;
	} catch (error) {
		if (error instanceof RunnerStageTimeoutError) {
			progress(`${stage}_timed_out`);
			throw new QaStatusError(
				"QA_RUN_FAILED",
				`browser QA stage ${stage} timed out`,
				EXIT_RUNNER_TIMEOUT,
				profileId,
				{ timedOut: true, lastStage: stage },
			);
		}
		progress(`${stage}_failed`, { errorType: error?.constructor?.name ?? typeof error });
		throw error;
	}
}

async function runCleanupStage(progress, stage, operation, deadline = Date.now() + CLEANUP_TIMEOUT_MS) {
	progress(`${stage}_started`);
	try {
		const result = await withDeadline(operation(), deadline, stage);
		progress(`${stage}_finished`);
		return result;
	} catch (error) {
		progress(error instanceof RunnerStageTimeoutError ? `${stage}_timed_out` : `${stage}_failed`, {
			errorType: error?.constructor?.name ?? typeof error,
		});
		throw error;
	}
}

class RunnerStageTimeoutError extends Error {
	constructor(stage) {
		super(`browser QA stage ${stage} timed out`);
		this.name = "RunnerStageTimeoutError";
	}
}

async function withDeadline(promise, deadline, stage) {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new RunnerStageTimeoutError(stage);
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new RunnerStageTimeoutError(stage)), remaining);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function collectSecrets(value, output = []) {
	if (!isObject(value)) return output;
	if (typeof value.token === "string" && value.token.length > 0) output.push(value.token);
	if (Array.isArray(value.fields)) {
		for (const field of value.fields) {
			if (isObject(field) && typeof field.value === "string" && field.value.length > 0) output.push(field.value);
		}
	}
	if (Array.isArray(value.cookies)) {
		for (const cookie of value.cookies) {
			if (isObject(cookie) && typeof cookie.value === "string" && cookie.value.length > 0) output.push(cookie.value);
		}
	}
	if (isObject(value.entries)) {
		for (const entry of Object.values(value.entries)) {
			if (typeof entry === "string" && entry.length > 0) output.push(entry);
		}
	}
	return expandSecretForms(output);
}

function collectStorageStateSecrets(state) {
	const output = [];
	if (isObject(state) && Array.isArray(state.cookies)) {
		for (const cookie of state.cookies) {
			if (isObject(cookie) && typeof cookie.value === "string" && cookie.value.length > 0) output.push(cookie.value);
		}
	}
	if (isObject(state) && Array.isArray(state.origins)) {
		for (const origin of state.origins) {
			if (!isObject(origin) || !Array.isArray(origin.localStorage)) continue;
			for (const entry of origin.localStorage) {
				if (isObject(entry) && typeof entry.value === "string" && entry.value.length > 0) output.push(entry.value);
			}
		}
	}
	return expandSecretForms(output);
}

function expandSecretForms(values) {
	const forms = new Set();
	for (const value of values) {
		if (typeof value !== "string" || value.length === 0) continue;
		forms.add(value);
		forms.add(encodeURIComponent(value));
		forms.add(Buffer.from(value, "utf8").toString("base64"));
		forms.add(Buffer.from(value, "utf8").toString("base64url"));
	}
	return [...forms].filter(Boolean).sort((left, right) => right.length - left.length);
}

async function assertBrowserDoesNotExposeSecrets(context, fallbackPage, secrets, profileId) {
	if (secrets.length === 0) return;
	const pages = typeof context?.pages === "function" ? context.pages() : [fallbackPage];
	for (const page of pages) {
		if (!page || page.isClosed()) continue;
		const frames = typeof page.frames === "function" ? page.frames() : [page];
		for (const frame of frames) {
			let haystacks;
			try { haystacks = [frame.url(), await frame.content()]; } catch { continue; }
			if (!secrets.some((secret) => secret && haystacks.some((value) => value.includes(secret)))) continue;
			const error = new QaStatusError("QA_RUN_FAILED", "configured authentication appeared in rendered page content; visual evidence was discarded", 1, profileId);
			error.suppressEvidence = true;
			throw error;
		}
	}
}

function sanitizeTraceArchive(tracePath, secrets) {
	const archive = unzipSync(new Uint8Array(fs.readFileSync(tracePath)));
	const sanitized = {};
	for (const [name, bytes] of Object.entries(archive)) {
		if (name.endsWith(".network")) continue;
		if (name.startsWith("resources/") && !isImage(bytes)) continue;
		if (isImage(bytes)) {
			sanitized[name] = bytes;
			continue;
		}
		let text = strFromU8(bytes);
		for (const secret of [...new Set(secrets)].filter(Boolean)) {
			text = text.split(secret).join("[REDACTED]");
		}
		sanitized[name] = strToU8(text);
	}
	if (Object.keys(sanitized).length === 0) throw new Error("trace archive contained no safe entries");
	for (const bytes of Object.values(sanitized)) {
		if (isImage(bytes)) continue;
		const text = strFromU8(bytes);
		for (const secret of secrets) {
			if (secret && text.includes(secret)) throw new Error("trace redaction verification failed");
		}
	}
	fs.writeFileSync(tracePath, zipSync(sanitized, { level: 6 }), { mode: 0o600 });
	fs.chmodSync(tracePath, 0o600);
}

function isImage(bytes) {
	return (
		(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
		|| (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		|| (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38)
		|| (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
	);
}

function redact(value, secrets) {
	let output = String(value).replace(/[\r\n]+/g, " ").slice(0, 500);
	for (const secret of secrets) if (secret) output = output.split(secret).join("[REDACTED]");
	return output;
}

function safeReason(error) {
	return error instanceof Error ? error.message : String(error);
}

function authError(profileId, reason) {
	return new QaStatusError("QA_AUTH_UPDATE_REQUIRED", reason, EXIT_AUTH_UPDATE_REQUIRED, profileId);
}

function isAllowedUrl(raw, allowedOrigins) {
	try {
		const url = new URL(raw);
		return !url.username && !url.password && allowedOrigins.includes(url.origin);
	} catch {
		return false;
	}
}

function resolveBrowserQaAgentDirectory(cwd, value) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${SUBAGENT_AGENT_DIR_ENV} is required for browser QA runs`);
	}
	const projectRoot = fs.realpathSync(cwd);
	const subagentRoot = path.join(projectRoot, ".pi", "subagents");
	const resolved = path.resolve(value);
	if (!fs.existsSync(resolved)) throw new Error("browser QA agent directory is missing");
	const real = fs.realpathSync(resolved);
	if (!isInside(subagentRoot, real)) throw new Error("browser QA agent directory must be inside .pi/subagents");
	assertNoSymlinkComponents(projectRoot, real, "browser QA agent directory");
	if (!fs.statSync(real).isDirectory()) throw new Error("browser QA agent directory must be a real directory");

	const promptFile = path.join(real, "prompt.md");
	const projectFile = path.join(real, "project_cwd");
	const typeFile = path.join(real, "subagent_type");
	for (const [file, label] of [[promptFile, "prompt"], [projectFile, "project metadata"], [typeFile, "type metadata"]]) {
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`browser QA ${label} is missing`);
		assertNoSymlinkComponents(real, file, `browser QA ${label}`);
	}
	const recordedProject = fs.readFileSync(projectFile, "utf8").trim();
	if (!recordedProject || fs.realpathSync(recordedProject) !== projectRoot) {
		throw new Error("browser QA agent directory belongs to another project");
	}
	if (fs.readFileSync(typeFile, "utf8").trim() !== "browser-qa") {
		throw new Error("browser QA runner requires a browser-qa sub-agent directory");
	}

	const workspace = path.join(real, QA_WORKSPACE_RELATIVE);
	if (!fs.existsSync(workspace)) throw new Error("browser QA workspace is missing");
	assertNoSymlinkComponents(real, workspace, "browser QA workspace");
	const workspaceStat = fs.statSync(workspace);
	if (!workspaceStat.isDirectory()) throw new Error("browser QA workspace must be a real directory");
	if (process.platform !== "win32" && (workspaceStat.mode & 0o077) !== 0) {
		throw new Error("browser QA workspace must use private directory permissions (0700)");
	}
	return real;
}

function resolveExistingPrivateFile(cwd, value, label, requirePrivate = true) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} path is missing`);
	const root = fs.realpathSync(cwd);
	const resolved = path.resolve(root, value);
	assertInside(root, resolved, label);
	if (!fs.existsSync(resolved)) throw new Error(`${label} is missing`);
	assertNoSymlinkComponents(root, resolved, label);
	const real = fs.realpathSync(resolved);
	assertInside(root, real, label);
	const stat = fs.statSync(real);
	if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
	if (requirePrivate && process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`${label} must use private file permissions (0600)`);
	return real;
}

function isInside(root, target) {
	const relative = path.relative(root, target);
	return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertInside(root, target, label) {
	if (isInside(root, target)) return;
	throw new Error(`${label} must be project-local`);
}

function assertNoSymlinkComponents(root, target, label) {
	let current = root;
	for (const part of path.relative(root, target).split(path.sep)) {
		current = path.join(current, part);
		if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${label} must not use symbolic links`);
	}

}

function createAuthTemplate(cwd) {
	const root = fs.realpathSync(cwd);
	const directory = path.join(root, path.dirname(CONFIG_RELATIVE));
	const file = path.join(root, CONFIG_RELATIVE);
	assertInside(root, directory, "auth config directory");
	if (!fs.existsSync(directory)) {
		try {
			fs.mkdirSync(directory, { mode: 0o700 });
		} catch (error) {
			if (!isAlreadyExistsError(error)) throw error;
		}
	}
	const directoryStat = fs.lstatSync(directory);
	if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
		throw new Error("auth config directory must be a real project-local directory");
	}
	try {
		fs.writeFileSync(file, AUTH_TEMPLATE, { encoding: "utf8", mode: 0o600, flag: "wx" });
	} catch (error) {
		if (isAlreadyExistsError(error)) return false;
		throw error;
	}
	fs.chmodSync(file, 0o600);
	return true;
}

function writeAuthScaffold(cwd, profileId, profile) {
	const initialTarget = assertAuthScaffoldWritable(cwd);
	const content = `// Generated by the trusted browser QA runner from the public login form.\n// Replace only __PI_QA_SECRET_n__ values yourself; agents must not read or edit this file.\n${JSON.stringify({ profiles: { [profileId]: profile } }, null, 2)}\n`;
	const temporaryFile = `${initialTarget.file}.scaffold-${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporaryFile, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		const descriptor = fs.openSync(temporaryFile, "r+");
		try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }

		const currentTarget = assertAuthScaffoldWritable(cwd);
		if (currentTarget.replacedEmptyTemplate !== initialTarget.replacedEmptyTemplate) {
			throw new QaStatusError("QA_RUN_FAILED", "auth config changed during scaffold creation; no file was overwritten", 1);
		}
		if (currentTarget.replacedEmptyTemplate) {
			fs.renameSync(temporaryFile, currentTarget.file);
		} else {
			try {
				fs.linkSync(temporaryFile, currentTarget.file);
			} catch (error) {
				if (isAlreadyExistsError(error)) throw new QaStatusError("QA_RUN_FAILED", "auth config changed during scaffold creation; no file was overwritten", 1);
				throw error;
			}
			fs.unlinkSync(temporaryFile);
		}
		return currentTarget.replacedEmptyTemplate;
	} finally {
		if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
	}
}

function assertAuthScaffoldWritable(cwd) {
	const root = fs.realpathSync(cwd);
	const directory = path.join(root, path.dirname(CONFIG_RELATIVE));
	const file = path.join(root, CONFIG_RELATIVE);
	assertInside(root, directory, "auth config directory");
	if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
	const directoryStat = fs.lstatSync(directory);
	if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
		throw new QaStatusError("QA_RUN_FAILED", "auth config directory must be a real project-local directory", 1);
	}

	let replacedEmptyTemplate = false;
	if (fs.existsSync(file)) {
		const existing = resolveExistingPrivateFile(root, CONFIG_RELATIVE, "auth config");
		const existingContent = fs.readFileSync(existing, "utf8");
		const errors = [];
		const value = parseJsonc(existingContent, errors, { allowTrailingComma: true });
		if (errors.length > 0 || !isObject(value) || !isObject(value.profiles)) {
			throw new QaStatusError("QA_RUN_FAILED", "existing auth config is invalid; scaffold creation will not overwrite it", 1);
		}
		if (Object.keys(value.profiles).length > 0) {
			throw new QaStatusError("QA_RUN_FAILED", "existing auth config has profiles; scaffold creation will not overwrite it", 1);
		}
		if (existingContent !== AUTH_TEMPLATE) {
			throw new QaStatusError("QA_RUN_FAILED", "existing empty auth config was not generated by the trusted runner; scaffold creation will not overwrite it", 1);
		}
		replacedEmptyTemplate = true;
	}
	return { file, replacedEmptyTemplate };
}

function isAlreadyExistsError(error) {
	return error !== null && typeof error === "object" && error.code === "EEXIST";
}

function createExclusivePrivateDirectory(cwd, target) {
	createPrivateDirectory(cwd, target, true);
}

function createPrivateDirectory(cwd, target, exclusive) {
	const root = fs.realpathSync(cwd);
	const resolved = path.resolve(target);
	assertInside(root, resolved, "evidence directory");
	const parts = path.relative(root, resolved).split(path.sep);
	let current = root;
	for (let index = 0; index < parts.length; index += 1) {
		current = path.join(current, parts[index]);
		const isFinal = index === parts.length - 1;
		if (fs.existsSync(current)) {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("evidence path must contain only real directories");
			if (isFinal && exclusive) throw new Error("evidence directory already exists");
			if (index > 0 && process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("QA private directories must use mode 0700");
		} else {
			fs.mkdirSync(current, { mode: 0o700 });
		}
	}
}

function safeRunId(value) {
	if (!isSafeName(value)) throw new Error("run id must contain only letters, digits, dot, underscore, or dash without dot segments");
	return value;
}

function isSafeName(value) {
	return typeof value === "string" && PROFILE_ID.test(value) && value !== "." && !value.includes("..");
}

function timestamp() {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function relativePath(cwd, value) {
	return (path.relative(cwd, value) || ".").split(path.sep).join("/");
}

function existingEvidence(evidenceDir) {
	return fs.readdirSync(evidenceDir)
		.filter((name) => /^(?:[A-Za-z0-9._-]+\.png|video(?:-popup-[A-Za-z0-9._-]+)?\.webm|trace\.zip|download-[A-Za-z0-9._-]+\.bin)$/.test(name))
		.sort();
}

function artifactManifest(evidenceDir, evidence) {
	const artifacts = { screenshots: [], videos: [], traces: [], downloads: [] };
	for (const name of evidence) {
		const absolutePath = path.resolve(evidenceDir, name);
		const artifact = { path: absolutePath, uri: pathToFileURL(absolutePath).href };
		if (name.endsWith(".png")) artifacts.screenshots.push(artifact);
		else if (name.endsWith(".webm")) artifacts.videos.push(artifact);
		else if (name.endsWith(".zip")) artifacts.traces.push(artifact);
		else if (name.endsWith(".bin")) artifacts.downloads.push(artifact);
	}
	return artifacts;
}

function removeVisualEvidence(evidenceDir) {
	for (const name of fs.readdirSync(evidenceDir)) {
		if (/\.(?:png|webm|zip|bin)$/.test(name)) fs.rmSync(path.join(evidenceDir, name), { force: true });
	}
}

function writeJsonPrivate(file, value) {
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	fs.chmodSync(file, 0o600);
}

function writeStatus(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function finitePositive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
