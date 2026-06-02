#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const minimumNodeVersion = [22, 19, 0];
const minimumNodeVersionLabel = "22.19.0";
const launcherPath = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(launcherPath));
const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const updatePath = fileURLToPath(new URL("../dist/app/cli/update.js", import.meta.url));
const installPath = fileURLToPath(new URL("../dist/app/cli/install.js", import.meta.url));
const distPath = dirname(mainPath);
const rawArgs = process.argv.slice(2);
const childArgs = [];
let reloadOnBuild = truthyEnv(process.env.PIX_RELOAD_ON_BUILD);

if (!isCurrentNodeSupported()) {
	console.error(`[pix] Node ${minimumNodeVersionLabel}+ is required; current Node is ${process.versions.node}.`);
	console.error("[pix] Install/use a newer Node, for example `mise install node@22.19.0` or `nvm install 22`.");
	process.exit(1);
}

for (const arg of rawArgs) {
	if (arg === "--reload-on-build") {
		reloadOnBuild = true;
		continue;
	}
	if (arg === "--no-reload-on-build") {
		reloadOnBuild = false;
		continue;
	}
	childArgs.push(arg);
}

if (childArgs[0] === "update") {
	if (!existsSync(updatePath)) {
		console.error("pix update is not built yet. Run `npm run build:pix` or update from a published package.");
		process.exit(1);
	}
	const { runPixUpdateCli } = await import(new URL("../dist/app/cli/update.js", import.meta.url));
	process.exit(await runPixUpdateCli(childArgs.slice(1)));
}

if (childArgs[0] === "install" || childArgs[0] === "setup") {
	if (!existsSync(installPath)) {
		console.error("pix install is not built yet. Run `npm run build:pix` or update from a published package.");
		process.exit(1);
	}
	const { runPixInstallCli } = await import(new URL("../dist/app/cli/install.js", import.meta.url));
	process.exit(await runPixInstallCli(childArgs.slice(1), { env: pixChildEnv() }));
}

if (!existsSync(mainPath)) {
	console.error("pix is not built yet. Run `npm run build:pix` or `npm run watch:pix`.");
	process.exit(1);
}

let child = undefined;
let reloadTimer = undefined;
let distPollTimer = undefined;
let distSnapshot = snapshotDist();
let restarting = false;
let shuttingDown = false;

startChild();
if (reloadOnBuild) startDistPolling();

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		shuttingDown = true;
		stopDistPolling();
		child?.kill(signal);
	});
}

function truthyEnv(value) {
	if (!value) return false;
	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function isCurrentNodeSupported() {
	const parts = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
	for (let index = 0; index < minimumNodeVersion.length; index += 1) {
		const current = parts[index] ?? 0;
		const minimum = minimumNodeVersion[index];
		if (current > minimum) return true;
		if (current < minimum) return false;
	}
	return true;
}

function startChild() {
	child = spawn(process.execPath, [mainPath, ...childArgs], {
		stdio: "inherit",
		env: pixChildEnv(),
	});

	child.on("error", (error) => {
		console.error(error.message);
		process.exitCode = 1;
	});

	child.on("exit", (code, signal) => {
		child = undefined;
		if (restarting) return;

		shuttingDown = true;
		stopDistPolling();
		if (signal) {
			process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
			return;
		}
		process.exitCode = code ?? 1;
	});
}

function pixChildEnv() {
	const env = { ...process.env };
	const bundledBinPath = join(packageRoot, "node_modules", ".bin");
	if (existsSync(bundledBinPath)) {
		env.PATH = [bundledBinPath, env.PATH ?? ""].filter(Boolean).join(delimiter);
		env.PIX_BUNDLED_PI_BIN = bundledBinPath;
	}
	return env;
}

function startDistPolling() {
	const pollInterval = Number(process.env.PIX_RELOAD_POLL_MS ?? 1000);
	distPollTimer = setInterval(() => {
		const nextSnapshot = snapshotDist();
		if (nextSnapshot === distSnapshot) return;

		distSnapshot = nextSnapshot;
		queueReload();
	}, Number.isFinite(pollInterval) && pollInterval > 0 ? pollInterval : 1000);
}

function stopDistPolling() {
	if (reloadTimer) clearTimeout(reloadTimer);
	if (distPollTimer) clearInterval(distPollTimer);
	reloadTimer = undefined;
	distPollTimer = undefined;
}

function queueReload() {
	if (shuttingDown) return;
	if (reloadTimer) clearTimeout(reloadTimer);
	reloadTimer = setTimeout(() => {
		reloadTimer = undefined;
		restartChild();
	}, 250);
}

function restartChild() {
	if (shuttingDown) return;
	if (!child) {
		startChild();
		return;
	}

	restarting = true;
	const currentChild = child;
	currentChild.once("exit", () => {
		restarting = false;
		if (!shuttingDown) startChild();
	});
	console.error("[pix] dist changed; restarting renderer");
	currentChild.kill("SIGTERM");
}

function snapshotDist() {
	let newestMtime = 0;
	let runtimeFileCount = 0;
	const pendingDirs = [distPath];

	while (pendingDirs.length > 0) {
		const currentDir = pendingDirs.pop();
		if (!currentDir) continue;

		let entries;
		try {
			entries = readdirSync(currentDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const entryPath = join(currentDir, entry.name);
			if (entry.isDirectory()) {
				pendingDirs.push(entryPath);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".js")) continue;

			runtimeFileCount += 1;
			try {
				newestMtime = Math.max(newestMtime, statSync(entryPath).mtimeMs);
			} catch {
				// If tsc is replacing a file while we scan, the next poll will see the final state.
			}
		}
	}

	return `${runtimeFileCount}:${newestMtime}`;
}
