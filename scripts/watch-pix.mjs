#!/usr/bin/env node

import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SUITE_ROOT = resolve(REPO_ROOT, "external", "pi-tools-suite");
const SYNC_SCRIPT = resolve(SCRIPT_DIR, "sync-pi-tools-suite.mjs");
const TSC_BIN = resolve(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const SYNCED_ENTRIES = new Set([
	"src",
	"docs",
	"licenses",
	"scripts",
	"index.ts",
	"package.json",
	"README.md",
]);
const SYNC_DEBOUNCE_MS = 150;

let syncProcess;
let syncPending = false;
let syncTimer;
let stopping = false;

function startSync(reason) {
	if (syncProcess) {
		syncPending = true;
		return;
	}

	console.error(`[watch:pix] syncing pi-tools-suite (${reason})`);
	syncProcess = spawn(process.execPath, [SYNC_SCRIPT], {
		cwd: REPO_ROOT,
		stdio: "inherit",
	});
	syncProcess.once("exit", (code, signal) => {
		syncProcess = undefined;
		if (code !== 0 && !stopping) {
			console.error(`[watch:pix] pi-tools-suite sync failed (${signal ?? `exit ${code}`})`);
		}
		if (syncPending && !stopping) {
			syncPending = false;
			startSync("queued changes");
		}
	});
}

function scheduleSync(filename) {
	if (!filename) return;
	const [entry] = String(filename).replaceAll("\\", "/").split("/");
	if (!SYNCED_ENTRIES.has(entry)) return;

	clearTimeout(syncTimer);
	syncTimer = setTimeout(() => startSync(filename), SYNC_DEBOUNCE_MS);
}

const suiteWatcher = watch(SUITE_ROOT, { recursive: true }, (_eventType, filename) => {
	scheduleSync(filename);
});

startSync("initial");

const tscProcess = spawn(process.execPath, [
	TSC_BIN,
	"-p",
	"tsconfig.json",
	"--watch",
	"--preserveWatchOutput",
	"--noEmitOnError",
], {
	cwd: REPO_ROOT,
	stdio: "inherit",
});

function stop(signal) {
	if (stopping) return;
	stopping = true;
	clearTimeout(syncTimer);
	suiteWatcher.close();
	if (syncProcess) syncProcess.kill(signal);
	if (tscProcess.exitCode === null) tscProcess.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => stop(signal));
}

suiteWatcher.on("error", (error) => {
	console.error(`[watch:pix] suite watcher failed: ${error.message}`);
	process.exitCode = 1;
	stop("SIGTERM");
});

tscProcess.once("exit", (code, signal) => {
	if (!stopping && code !== 0) {
		console.error(`[watch:pix] TypeScript watcher stopped (${signal ?? `exit ${code}`})`);
	}
	process.exitCode = code ?? (signal ? 1 : 0);
	stop("SIGTERM");
});

