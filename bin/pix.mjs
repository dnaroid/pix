#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requiredNodeMajor = 24;
const launcherPath = fileURLToPath(import.meta.url);
const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const updatePath = fileURLToPath(new URL("../dist/app/update.js", import.meta.url));
const distPath = dirname(mainPath);
const rawArgs = process.argv.slice(2);
const childArgs = [];
let reloadOnBuild = truthyEnv(process.env.PIX_RELOAD_ON_BUILD);

if (currentNodeMajor() !== requiredNodeMajor && process.env.PIX_NODE24_REEXEC !== "1") {
	await reexecWithNode24(rawArgs);
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
	const { runPixUpdateCli } = await import(new URL("../dist/app/update.js", import.meta.url));
	process.exit(await runPixUpdateCli(childArgs.slice(1)));
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

function currentNodeMajor() {
	return Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
}

async function reexecWithNode24(args) {
	console.error(`[pix] switching from Node ${process.versions.node} to Node 24.16.0`);
	const candidates = node24Candidates(args);

	for (const candidate of candidates) {
		const result = await runNode24Candidate(candidate.command, candidate.args);
		if (!result.launched) continue;
		if (result.signal) process.exitCode = result.signal === "SIGINT" ? 130 : result.signal === "SIGTERM" ? 143 : 1;
		else process.exitCode = result.code ?? 1;
		process.exit();
	}

	console.error("[pix] Node 24 is required. Install/use it with `mise install node@24.16.0` or set PIX_NODE24=/path/to/node24.");
	process.exit(1);
}

function node24Candidates(args) {
	const envNode = process.env.PIX_NODE24;
	return [
		...(envNode ? [{ command: envNode, args: [launcherPath, ...args] }] : []),
		{ command: "mise", args: ["exec", "node@24.16.0", "--", "node", launcherPath, ...args] },
		{ command: "node24", args: [launcherPath, ...args] },
		{ command: "node-24", args: [launcherPath, ...args] },
	];
}

async function runNode24Candidate(command, args) {
	return await new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: "inherit",
			env: { ...process.env, PIX_NODE24_REEXEC: "1" },
		});

		child.once("error", (error) => {
			if (error && error.code === "ENOENT") resolve({ launched: false });
			else {
				console.error(error?.message ?? String(error));
				resolve({ launched: true, code: 1 });
			}
		});
		child.once("exit", (code, signal) => resolve({ launched: true, code, signal }));
	});
}

function startChild() {
	child = spawn(process.execPath, [mainPath, ...childArgs], {
		stdio: "inherit",
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
