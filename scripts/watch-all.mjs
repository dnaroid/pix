#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants, existsSync, watch } from "node:fs";
import { chmod, copyFile, cp, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DESKTOP_ROOT = resolve(REPO_ROOT, "desktop");
const TAURI_ROOT = resolve(DESKTOP_ROOT, "src-tauri");
const CARGO_TARGET_DIR = resolve(TAURI_ROOT, "target", "watch-all");
const SYNC_SCRIPT = resolve(SCRIPT_DIR, "sync-pi-tools-suite.mjs");
const DESKTOP_BINARY_NAME = process.platform === "win32" ? "pix-desktop.exe" : "pix-desktop";
const DESKTOP_BINARY = resolve(CARGO_TARGET_DIR, "debug", DESKTOP_BINARY_NAME);
const MACOS_OPEN_PATH = "/usr/bin/open";
const MACOS_CODESIGN_PATH = "/usr/bin/codesign";
const MACOS_DEV_BUNDLE_IDENTIFIER = "dev.pix.desktop";
const PS_COMMAND = "/bin/ps";
const PS_ARGUMENTS = ["-axo", "pid=,command="];
const APP_PID_POLL_MS = 100;
const APP_PID_TIMEOUT_MS = 10_000;
const APP_PID_CLEANUP_TIMEOUT_MS = 1_000;
const APP_EXIT_WAIT_MS = 2_000;
const APP_KILL_WAIT_MS = 500;
const DEBOUNCE_MS = 200;
const STARTUP_GRACE_MS = 800;
const NATIVE_ICON_PATH = "desktop/src-tauri/icons";

export const PARTS = Object.freeze({
	SUITE: "suite",
	PIX: "pix",
	ACP: "acp",
	WEB: "web",
	NATIVE: "native",
});

const PART_ORDER = [PARTS.SUITE, PARTS.PIX, PARTS.ACP, PARTS.WEB, PARTS.NATIVE];
const SUITE_ENTRIES = new Set([
	"src",
	"docs",
	"licenses",
	"scripts",
	"index.ts",
	"package.json",
	"README.md",
]);
const SUITE_IGNORED_ENTRIES = new Set(["node_modules", "dist", "reports", ".pi"]);
const ROOT_FILES = new Set(["package.json", "package-lock.json", "tsconfig.json"]);
const ACP_FILES = new Set(["package.json", "package-lock.json", "tsconfig.json"]);
const WEB_FILES = new Set([
	"index.html",
	"package.json",
	"package-lock.json",
	"svelte.config.js",
	"svelte.config.ts",
	"tsconfig.json",
	"tsconfig.node.json",
	"vite.config.js",
	"vite.config.ts",
]);
const NATIVE_FILES = new Set(["build.rs", "Cargo.lock", "Cargo.toml", "tauri.conf.json"]);

function normalizedPath(path) {
	return String(path).replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

/** Return the independently buildable project parts affected by a repository-relative path. */
export function classifyChange(path) {
	const relativePath = normalizedPath(path);
	const parts = new Set();

	if (relativePath === "src" || relativePath.startsWith("src/")) parts.add(PARTS.PIX);
	if (ROOT_FILES.has(relativePath) || relativePath === "scripts/generate-schemas.ts") {
		parts.add(PARTS.PIX);
	}

	if (relativePath === "acp/src" || relativePath.startsWith("acp/src/")) parts.add(PARTS.ACP);
	if (relativePath.startsWith("acp/") && ACP_FILES.has(relativePath.slice("acp/".length))) {
		parts.add(PARTS.ACP);
	}

	if (relativePath === "desktop/src" || relativePath.startsWith("desktop/src/")) {
		parts.add(PARTS.WEB);
	}
	if (relativePath.startsWith("desktop/") && WEB_FILES.has(relativePath.slice("desktop/".length))) {
		parts.add(PARTS.WEB);
	}

	if (
		relativePath === "desktop/src-tauri/src"
		|| relativePath.startsWith("desktop/src-tauri/src/")
		|| relativePath === "desktop/src-tauri/capabilities"
		|| relativePath.startsWith("desktop/src-tauri/capabilities/")
		|| relativePath === "desktop/src-tauri/icons"
		|| relativePath.startsWith("desktop/src-tauri/icons/")
	) {
		parts.add(PARTS.NATIVE);
	}
	if (
		relativePath.startsWith("desktop/src-tauri/")
		&& (
			NATIVE_FILES.has(relativePath.slice("desktop/src-tauri/".length))
			|| /^tauri\..+\.conf\.json$/u.test(relativePath.slice("desktop/src-tauri/".length))
		)
	) {
		parts.add(PARTS.NATIVE);
	}

	const suitePrefix = "external/pi-tools-suite/";
	if (relativePath === "external/pi-tools-suite") {
		parts.add(PARTS.SUITE);
	} else if (relativePath.startsWith(suitePrefix)) {
		const [entry] = relativePath.slice(suitePrefix.length).split("/");
		if (entry && !SUITE_IGNORED_ENTRIES.has(entry) && SUITE_ENTRIES.has(entry)) {
			parts.add(PARTS.SUITE);
		}
	}

	return parts;
}

/** Expand direct changes into an ordered build plan. Web assets are embedded by the native build. */
export function createBuildPlan(changedParts, options = {}) {
	const { initial = false, hasNativeBuild = true } = options;
	const parts = new Set(initial ? PART_ORDER : changedParts);
	if (parts.has(PARTS.WEB)) parts.add(PARTS.NATIVE);
	if (!hasNativeBuild) {
		parts.add(PARTS.WEB);
		parts.add(PARTS.NATIVE);
	}
	const steps = PART_ORDER.filter((part) => parts.has(part));
	return {
		steps,
		restartDesktop: steps.some((part) => part !== PARTS.SUITE),
	};
}

/** Whether the platform launches the desktop from a debug .app bundle instead of the raw executable. */
export function usesDesktopAppBundle(platform = process.platform) {
	return platform === "darwin";
}

/**
 * Tauri build arguments for the platform's native debug step. Web assets are already built, so
 * `beforeBuildCommand` stays empty; only macOS bundles a debug .app for the Dock icon and to keep
 * the prior Tauri/WebKit workspace localStorage context. Other platforms keep the raw executable.
 */
export function desktopBuildArguments(platform = process.platform) {
	const config = { build: { beforeBuildCommand: "" } };
	if (usesDesktopAppBundle(platform)) config.bundle = { active: true };
	const args = ["--debug"];
	if (usesDesktopAppBundle(platform)) {
		args.push("--bundles", "app");
	} else {
		args.push("--no-bundle");
	}
	args.push("--ci", "--config", JSON.stringify(config));
	return args;
}

/** Directory where the macOS debug .app bundles are written. */
export function desktopBundleDirectory(targetDir = CARGO_TARGET_DIR) {
	return join(targetDir, "debug", "bundle", "macos");
}

/** Pick the newest validated macOS .app bundle candidate; ties break on path for determinism. */
export function selectDesktopAppBundle(candidates) {
	return [...candidates].sort((a, b) => b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path))[0];
}

/**
 * Executable path of a copied desktop artifact: the bundle's inner binary on macOS (used to make the
 * copy executable and to discover the LaunchServices-launched app PID), otherwise the artifact itself.
 */
export function desktopLaunchExecutable(artifact, platform = process.platform, binaryName = DESKTOP_BINARY_NAME) {
	if (!usesDesktopAppBundle(platform)) return artifact;
	return join(artifact, "Contents", "MacOS", binaryName);
}

/**
 * Destination for a copied artifact. On macOS each bundle lives under a unique parent directory while
 * keeping its source basename (`Pix Desktop.app`), so every launch has a unique inner executable for
 * PID discovery and a real bundle identity for LaunchServices. Other platforms copy the artifact flat.
 */
export function desktopArtifactDestination(tempDirectory, sequence, source, platform = process.platform) {
	if (usesDesktopAppBundle(platform)) {
		return join(tempDirectory, `pix-desktop-${sequence}`, basename(source));
	}
	const suffix = platform === "win32" ? ".exe" : "";
	return join(tempDirectory, `pix-desktop-${sequence}${suffix}`);
}

/** .app bundle that contains the given inner executable. */
export function desktopAppBundlePath(executablePath) {
	return resolve(executablePath, "..", "..", "..");
}

/** Arguments that make /usr/bin/open launch a fresh app instance and wait until it exits. */
export function macOSOpenArguments(bundlePath) {
	return ["-n", "-W", bundlePath];
}

/**
 * Re-sign a watch:all debug bundle with a stable designated requirement.
 *
 * Tauri's linker-produced ad-hoc signature defaults to a CDHash requirement,
 * which changes on every native/web rebuild. macOS TCC then treats each build
 * as a different application and asks for Home-folder access again. An
 * explicit identifier-only designated requirement keeps the development app's
 * identity stable without requiring a developer certificate.
 */
export function macOSCodeSignArguments(bundlePath, identifier = MACOS_DEV_BUNDLE_IDENTIFIER) {
	return [
		"--force",
		"--deep",
		"--sign",
		"-",
		"--identifier",
		identifier,
		"--requirements",
		`=designated => identifier "${identifier}"`,
		bundlePath,
	];
}

/** Parse `ps -axo pid=,command=` output into `{ pid, command }` records. */
export function parseProcessList(output) {
	const entries = [];
	for (const line of String(output).split("\n")) {
		const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(line);
		if (match) entries.push({ pid: Number(match[1]), command: match[2] });
	}
	return entries;
}

/** PID whose command line runs the exact executable path (trailing arguments allowed, prefixes rejected). */
export function findProcessByExecutablePath(entries, executablePath) {
	const argumentPrefix = executablePath.endsWith(" ") ? executablePath : `${executablePath} `;
	return entries.find((entry) => entry.command === executablePath || entry.command.startsWith(argumentPrefix))?.pid;
}

/** Update a cached filesystem stamp and report whether the path actually changed. */
export function updateWatchedPathStamp(stamps, path, stamp) {
	const previous = stamps.get(path);
	stamps.set(path, stamp);
	return previous === undefined || previous !== stamp;
}

/** Invoke npm without relying on direct `.cmd` spawning, which modern Node rejects on Windows. */
export function npmInvocation(args, platform = process.platform, npmExecPath = process.env.npm_execpath) {
	if (platform !== "win32") return { command: "npm", args };
	if (!npmExecPath) {
		throw new Error("watch:all on Windows must be started through npm so npm_execpath is available");
	}
	return { command: process.execPath, args: [npmExecPath, ...args] };
}

async function watchedPathStamp(path) {
	try {
		const stats = await stat(path);
		return `${stats.isDirectory() ? "directory" : "file"}:${stats.size}:${stats.mtimeMs}`;
	} catch (error) {
		if (error?.code === "ENOENT") return "missing";
		throw error;
	}
}

function delay(milliseconds) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function exitPromise(child) {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolveExit) => {
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
	});
}

async function signalProcessTree(child, signal = "SIGTERM") {
	if (!child || child.pid === undefined) return;
	if (process.platform === "win32") {
		await new Promise((resolveTaskkill) => {
			const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			taskkill.once("error", () => resolveTaskkill());
			taskkill.once("exit", () => resolveTaskkill());
		});
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

async function stopProcessTree(child) {
	if (!child || child.pid === undefined) return;
	const exited = exitPromise(child);
	await signalProcessTree(child, "SIGTERM");
	await Promise.race([exited, delay(2_000)]);
	await signalProcessTree(child, "SIGKILL");
	await Promise.race([exited, delay(500)]);
}

function processListSnapshot() {
	return new Promise((resolveSnapshot, rejectSnapshot) => {
		const ps = spawn(PS_COMMAND, PS_ARGUMENTS, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		ps.stdout.on("data", (chunk) => {
			output += chunk;
		});
		ps.once("error", rejectSnapshot);
		ps.once("exit", (code) => {
			if (code === 0) resolveSnapshot(output);
			else rejectSnapshot(new Error(`${PS_COMMAND} ${PS_ARGUMENTS.join(" ")} exited with code ${code}`));
		});
	});
}

/** Poll the process list for the app running the exact unique inner executable path. */
async function findDesktopAppPid(executablePath, isAborted, onFound, timeoutMs = APP_PID_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const pid = findProcessByExecutablePath(parseProcessList(await processListSnapshot()), executablePath);
		if (pid !== undefined) {
			onFound?.(pid);
			return pid;
		}
		if (isAborted()) return undefined;
		await delay(APP_PID_POLL_MS);
	}
	return undefined;
}

async function waitForProcessExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!parseProcessList(await processListSnapshot()).some((entry) => entry.pid === pid)) return true;
		await delay(APP_PID_POLL_MS);
	}
	return false;
}

/** Signal the app's own Unix process group, falling back to the PID alone if it leads no group. */
async function signalAppProcess(appPid, signal = "SIGTERM") {
	for (const group of [true, false]) {
		try {
			process.kill(group ? -appPid : appPid, signal);
			return;
		} catch (error) {
			if (error?.code !== "ESRCH") throw error;
		}
	}
}

async function stopDesktopAppProcess(appPid) {
	await signalAppProcess(appPid, "SIGTERM");
	if (!(await waitForProcessExit(appPid, APP_EXIT_WAIT_MS))) {
		await signalAppProcess(appPid, "SIGKILL");
		await waitForProcessExit(appPid, APP_KILL_WAIT_MS);
	}
}

class WatchAllSupervisor {
	constructor() {
		this.watchers = [];
		this.pendingParts = new Set();
		this.blockedParts = new Set();
		this.building = false;
		this.stopping = false;
		this.initialBuild = true;
		this.hasNativeBuild = false;
		this.restartPending = false;
		this.buildTimer = undefined;
		this.activeCommand = undefined;
		this.desktopProcess = undefined;
		this.desktopAppPid = undefined;
		this.candidateProcess = undefined;
		this.candidateAppPid = undefined;
		this.desktopExecutable = undefined;
		this.tempDirectory = undefined;
		this.executableSequence = 0;
		this.watchedPathStamps = new Map();
	}

	async start() {
		// `ps` reports macOS temporary paths through their canonical `/private/var/...` spelling.
		// Canonicalize our copy root too so exact executable-path PID discovery remains reliable.
		this.tempDirectory = await realpath(await mkdtemp(join(tmpdir(), "pix-watch-all-")));
		await this.seedWatchedPathStamps(NATIVE_ICON_PATH);
		this.startWatchers();
		this.queueParts(PART_ORDER, "initial build", { immediate: true });
	}

	async seedWatchedPathStamps(relativePath) {
		const absolutePath = resolve(REPO_ROOT, relativePath);
		const stamp = await watchedPathStamp(absolutePath);
		this.watchedPathStamps.set(relativePath, stamp);
		if (!existsSync(absolutePath) || !stamp.startsWith("directory:")) return;
		for (const entry of await readdir(absolutePath, { withFileTypes: true })) {
			await this.seedWatchedPathStamps(normalizedPath(join(relativePath, entry.name)));
		}
	}

	async handleWatchEvent(relativePath) {
		if (relativePath === NATIVE_ICON_PATH || relativePath.startsWith(`${NATIVE_ICON_PATH}/`)) {
			const stamp = await watchedPathStamp(resolve(REPO_ROOT, relativePath));
			if (!updateWatchedPathStamp(this.watchedPathStamps, relativePath, stamp)) return;
		}
		const parts = classifyChange(relativePath);
		if (parts.size > 0) this.queueParts(parts, relativePath);
	}

	startWatchers() {
		const targets = [
			{ path: "", recursive: false },
			{ path: "src", recursive: true },
			{ path: "scripts", recursive: false },
			{ path: "acp", recursive: false },
			{ path: "acp/src", recursive: true },
			{ path: "desktop", recursive: false },
			{ path: "desktop/src", recursive: true },
			{ path: "desktop/src-tauri", recursive: false },
			{ path: "desktop/src-tauri/src", recursive: true },
			{ path: "desktop/src-tauri/capabilities", recursive: true },
			{ path: "desktop/src-tauri/icons", recursive: true },
			{ path: "external/pi-tools-suite", recursive: true },
		];

		for (const target of targets) {
			const absolutePath = resolve(REPO_ROOT, target.path);
			if (!existsSync(absolutePath)) continue;
			const watcher = watch(absolutePath, { recursive: target.recursive }, (_eventType, filename) => {
				if (!filename) return;
				const relativePath = normalizedPath(join(target.path, String(filename)));
				void this.handleWatchEvent(relativePath).catch((error) => {
					console.error(`[watch:all] could not inspect changed path ${relativePath}: ${error.message}`);
					void this.stop(1);
				});
			});
			watcher.on("error", (error) => {
				console.error(`[watch:all] watcher failed for ${target.path || "."}: ${error.message}`);
				void this.stop(1);
			});
			this.watchers.push(watcher);
		}
	}

	queueParts(parts, reason, options = {}) {
		if (this.stopping) return;
		for (const part of this.blockedParts) this.pendingParts.add(part);
		this.blockedParts.clear();
		for (const part of parts) this.pendingParts.add(part);
		console.error(`[watch:all] change queued (${reason}): ${[...parts].join(", ")}`);
		if (this.building) return;
		clearTimeout(this.buildTimer);
		this.buildTimer = setTimeout(() => void this.runQueuedBuild(), options.immediate ? 0 : DEBOUNCE_MS);
	}

	async runQueuedBuild() {
		if (this.stopping || this.building || this.pendingParts.size === 0) return;
		this.building = true;
		const requestedParts = new Set(this.pendingParts);
		this.pendingParts.clear();
		const plan = createBuildPlan(requestedParts, {
			initial: this.initialBuild,
			hasNativeBuild: this.hasNativeBuild,
		});
		this.initialBuild = false;
		console.error(`[watch:all] building: ${plan.steps.join(" → ")}`);

		let succeeded = false;
		try {
			for (const step of plan.steps) await this.runBuildStep(step);
			succeeded = true;
			if (plan.restartDesktop) this.restartPending = true;
			console.error("[watch:all] build cycle succeeded");
		} catch (error) {
			if (!this.stopping) {
				console.error(`[watch:all] build cycle failed: ${error instanceof Error ? error.message : String(error)}`);
				for (const part of requestedParts) this.blockedParts.add(part);
			}
		}

		if (this.pendingParts.size > 0) {
			if (!succeeded) {
				for (const part of this.blockedParts) this.pendingParts.add(part);
				this.blockedParts.clear();
			}
			if (this.restartPending) {
				console.error("[watch:all] desktop restart deferred until queued changes build successfully");
			}
		} else if (succeeded && this.restartPending && !this.stopping) {
			try {
				const restarted = await this.restartDesktop();
				if (restarted) this.restartPending = false;
			} catch (error) {
				console.error(`[watch:all] desktop restart failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		this.building = false;
		if (this.pendingParts.size > 0 && !this.stopping) {
			this.buildTimer = setTimeout(() => void this.runQueuedBuild(), DEBOUNCE_MS);
		}
	}

	async runBuildStep(step) {
		switch (step) {
			case PARTS.SUITE:
				await this.runCommand("sync pi-tools-suite", process.execPath, [SYNC_SCRIPT], REPO_ROOT);
				break;
			case PARTS.PIX:
				await this.runNpmCommand("build Pix", ["run", "--silent", "build:pix", "--", "--noEmitOnError"], REPO_ROOT);
				if (!this.hasNativeBuild) {
					await this.runNpmCommand("link Pix", ["link", "--silent", "--ignore-scripts"], REPO_ROOT);
				}
				break;
			case PARTS.ACP:
				await this.runNpmCommand("build ACP", ["--prefix", "acp", "run", "--silent", "build", "--", "--noEmitOnError"], REPO_ROOT);
				break;
			case PARTS.WEB:
				await this.runNpmCommand("build desktop web", ["--prefix", "desktop", "run", "--silent", "build:web"], REPO_ROOT);
				break;
			case PARTS.NATIVE:
				await this.runNpmCommand(
					"build desktop native",
					["--prefix", "desktop", "exec", "tauri", "build", "--", ...desktopBuildArguments(process.platform)],
					REPO_ROOT,
					{ CARGO_TARGET_DIR },
				);
				await this.captureDesktopArtifact();
				this.hasNativeBuild = true;
				break;
			default:
				throw new Error(`unknown build step: ${step}`);
		}
	}

	async runNpmCommand(label, args, cwd, environment = {}) {
		const invocation = npmInvocation(args);
		await this.runCommand(label, invocation.command, invocation.args, cwd, environment);
	}

	async runCommand(label, command, args, cwd, environment = {}) {
		if (this.stopping) throw new Error("watcher is stopping");
		console.error(`[watch:all] ${label}`);
		const child = spawn(command, args, {
			cwd,
			stdio: "inherit",
			detached: process.platform !== "win32",
			env: { ...process.env, ...environment },
		});
		this.activeCommand = child;
		let result;
		try {
			result = await new Promise((resolveCommand, rejectCommand) => {
				child.once("error", rejectCommand);
				child.once("exit", (code, signal) => resolveCommand({ code, signal }));
			});
		} finally {
			if (this.activeCommand === child) this.activeCommand = undefined;
		}
		if (result.code !== 0) throw new Error(`${label} failed (${result.signal ?? `exit ${result.code}`})`);
	}

	async captureDesktopArtifact() {
		if (!this.tempDirectory) throw new Error("temporary executable directory is unavailable");
		if (usesDesktopAppBundle()) {
			const bundle = await this.findMacOSDesktopBundle();
			if (!bundle) {
				throw new Error(`desktop .app bundle was not produced in ${desktopBundleDirectory()}`);
			}
			await this.copyDesktopArtifact(bundle.path, true);
			return;
		}
		if (!existsSync(DESKTOP_BINARY)) throw new Error(`desktop binary was not produced at ${DESKTOP_BINARY}`);
		await this.copyDesktopArtifact(DESKTOP_BINARY, false);
	}

	async findMacOSDesktopBundle() {
		const bundleRoot = desktopBundleDirectory();
		if (!existsSync(bundleRoot)) return undefined;
		const candidates = [];
		for (const entry of await readdir(bundleRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
			const path = join(bundleRoot, entry.name);
			if (!existsSync(join(path, "Contents", "MacOS", DESKTOP_BINARY_NAME))) continue;
			const stats = await stat(path);
			candidates.push({ name: entry.name, path, modifiedMs: stats.mtimeMs });
		}
		return selectDesktopAppBundle(candidates);
	}

	async copyDesktopArtifact(source, isBundle) {
		this.executableSequence += 1;
		const destination = desktopArtifactDestination(this.tempDirectory, this.executableSequence, source, process.platform);
		if (isBundle) {
			await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
			if (usesDesktopAppBundle()) {
				await this.runCommand(
					"sign desktop bundle for stable macOS permissions",
					MACOS_CODESIGN_PATH,
					macOSCodeSignArguments(destination),
					REPO_ROOT,
				);
			}
		} else {
			await copyFile(source, destination, fsConstants.COPYFILE_FICLONE);
		}
		if (process.platform !== "win32") await chmod(desktopLaunchExecutable(destination), 0o755);
		this.desktopExecutable = desktopLaunchExecutable(destination);
	}

	/**
	 * Launch a fresh desktop instance. On macOS `open -n -W` hands the copied .app to LaunchServices so
	 * the app gets a real bundle identity (and localStorage context); the tracked child is the short-lived
	 * `open` process, so the actual app PID is discovered separately. Other platforms spawn the executable.
	 */
	spawnDesktopCandidate() {
		const bundleLaunch = usesDesktopAppBundle();
		const child = spawn(bundleLaunch ? MACOS_OPEN_PATH : this.desktopExecutable, bundleLaunch
			? macOSOpenArguments(desktopAppBundlePath(this.desktopExecutable))
			: [], {
			cwd: REPO_ROOT,
			stdio: "inherit",
			detached: process.platform !== "win32",
			env: process.env,
		});
		return {
			process: child,
			appPid: bundleLaunch ? undefined : child.pid,
			executable: this.desktopExecutable,
		};
	}

	/** Terminate a desktop instance: signal the app's own process group first, then clean up the child. */
	async stopDesktopInstance(instance) {
		if (!instance?.process) return;
		if (usesDesktopAppBundle() && instance.appPid === undefined && instance.executable) {
			instance.appPid = await findDesktopAppPid(
				instance.executable,
				() => instance.process.exitCode !== null || instance.process.signalCode !== null,
				undefined,
				APP_PID_CLEANUP_TIMEOUT_MS,
			);
		}
		if (instance.appPid !== undefined && instance.appPid !== instance.process.pid) {
			await stopDesktopAppProcess(instance.appPid);
		}
		await stopProcessTree(instance.process);
	}

	async restartDesktop() {
		if (!this.desktopExecutable) throw new Error("no successfully built desktop executable is available");
		const previous = this.desktopProcess
			? { process: this.desktopProcess, appPid: this.desktopAppPid }
			: undefined;
		if (previous) {
			console.error("[watch:all] stopping the previous desktop before starting the newly built desktop");
			// Clear the tracked instance before signalling it so its exit listener cannot race with
			// assignment of the replacement process and clear the newly accepted instance.
			this.desktopProcess = undefined;
			this.desktopAppPid = undefined;
			await this.stopDesktopInstance(previous);
			if (this.stopping || this.pendingParts.size > 0) {
				if (!this.stopping) {
					console.error("[watch:all] desktop restart deferred because newer changes were queued while stopping the previous process");
				}
				return false;
			}
		} else {
			console.error("[watch:all] starting the newly built desktop");
		}
		const candidate = this.spawnDesktopCandidate();
		this.candidateProcess = candidate.process;
		this.candidateAppPid = candidate.appPid;
		let accepted = false;
		try {
			await new Promise((resolveSpawn, rejectSpawn) => {
				candidate.process.once("spawn", resolveSpawn);
				candidate.process.once("error", rejectSpawn);
			});
			await delay(STARTUP_GRACE_MS);
			if (candidate.process.exitCode !== null || candidate.process.signalCode !== null) {
				throw new Error(`new desktop exited during startup (${candidate.process.signalCode ?? `exit ${candidate.process.exitCode}`})`);
			}
			if (usesDesktopAppBundle()) {
				const executablePath = this.desktopExecutable;
				candidate.appPid = await findDesktopAppPid(
					executablePath,
					() => candidate.process.exitCode !== null || candidate.process.signalCode !== null,
					(pid) => {
						candidate.appPid = pid;
						this.candidateAppPid = pid;
					},
				);
				if (candidate.appPid === undefined) {
					throw new Error(`could not find the launched desktop process (${executablePath})`);
				}
				this.candidateAppPid = candidate.appPid;
			}
			if (this.stopping || this.pendingParts.size > 0) {
				if (!this.stopping) {
					console.error("[watch:all] desktop restart deferred because newer changes were queued during startup");
				}
				return false;
			}
			accepted = true;
		} finally {
			if (!accepted) await this.stopDesktopInstance(candidate);
			this.candidateAppPid = undefined;
			if (this.candidateProcess === candidate.process) this.candidateProcess = undefined;
		}

		this.desktopProcess = candidate.process;
		this.desktopAppPid = candidate.appPid;
		candidate.process.once("exit", (code, signal) => {
			if (!this.stopping && this.desktopProcess === candidate.process) {
				console.error(`[watch:all] desktop stopped (${signal ?? `exit ${code}`}); waiting for the next successful build`);
				this.desktopProcess = undefined;
				this.desktopAppPid = undefined;
			}
		});
		console.error("[watch:all] desktop is running the latest successful build");
		return true;
	}

	async stop(exitCode = 0) {
		if (this.stopping) return;
		this.stopping = true;
		clearTimeout(this.buildTimer);
		for (const watcher of this.watchers) watcher.close();
		if (this.activeCommand) await stopProcessTree(this.activeCommand);
		if (this.candidateProcess) {
			await this.stopDesktopInstance({
				process: this.candidateProcess,
				appPid: this.candidateAppPid,
				executable: this.desktopExecutable,
			});
		}
		if (this.desktopProcess) {
			await this.stopDesktopInstance({ process: this.desktopProcess, appPid: this.desktopAppPid });
		}
		if (this.tempDirectory) {
			await rm(this.tempDirectory, { recursive: true, force: true });
		}
		process.exitCode = exitCode;
	}
}

async function main() {
	const supervisor = new WatchAllSupervisor();
	for (const signal of ["SIGINT", "SIGTERM"]) {
		// npm can forward the same terminal signal after the process group already received it.
		// Keep the listener installed so a duplicate cannot trigger Node's default immediate exit
		// while the first signal is still shutting down the detached Desktop app.
		process.on(signal, () => void supervisor.stop());
	}
	try {
		await supervisor.start();
	} catch (error) {
		await supervisor.stop(1);
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
	main().catch((error) => {
		console.error(`[watch:all] fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
