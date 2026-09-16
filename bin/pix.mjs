#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const supportedNodeRange = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines.node;
const launcherPath = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(launcherPath));
const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const updatePath = fileURLToPath(new URL("../dist/app/cli/update.js", import.meta.url));
const installPath = fileURLToPath(new URL("../dist/app/cli/install.js", import.meta.url));
const cliArgs = process.argv.slice(2);

if (!isCurrentNodeSupported()) {
	console.error(`[pix] Node ${supportedNodeRange} is required; current Node is ${process.versions.node}.`);
	console.error("[pix] Install a supported Node.js release and ensure node and npm use it on PATH.");
	process.exit(1);
}

applyPixRuntimeEnv();

if (cliArgs[0] === "update") {
	if (!existsSync(updatePath)) {
		console.error("pix update is not built yet. Run `npm run build:pix` or update from a published package.");
		process.exit(1);
	}
	const { runPixUpdateCli } = await import(new URL("../dist/app/cli/update.js", import.meta.url));
	process.exit(await runPixUpdateCli(cliArgs.slice(1)));
}

if (cliArgs[0] === "install" || cliArgs[0] === "setup") {
	if (!existsSync(installPath)) {
		console.error("pix install is not built yet. Run `npm run build:pix` or update from a published package.");
		process.exit(1);
	}
	const { runPixInstallCli } = await import(new URL("../dist/app/cli/install.js", import.meta.url));
	process.exit(await runPixInstallCli(cliArgs.slice(1), { env: process.env }));
}

if (!existsSync(mainPath)) {
	console.error("pix is not built yet. Run `npm run build:pix` or `npm run watch:pix`.");
	process.exit(1);
}
await import(new URL("../dist/main.js", import.meta.url));

function isCurrentNodeSupported() {
	// Only the project's bounded stable range is accepted; fail closed if its format changes.
	const range = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/u.exec(supportedNodeRange);
	const version = /^(\d+)\.(\d+)\.(\d+)$/u.exec(process.versions.node);
	if (!range || !version) return false;
	const minimumNodeVersion = range.slice(1, 4).map(Number);
	const parts = version.slice(1).map(Number);
	if (parts[0] >= Number(range[4])) return false;
	for (let index = 0; index < minimumNodeVersion.length; index += 1) {
		const current = parts[index];
		const minimum = minimumNodeVersion[index];
		if (current > minimum) return true;
		if (current < minimum) return false;
	}
	return true;
}

function applyPixRuntimeEnv() {
	const bundledBinPath = join(packageRoot, "node_modules", ".bin");
	if (existsSync(bundledBinPath)) {
		process.env.PATH = [bundledBinPath, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
		process.env.PIX_BUNDLED_PI_BIN = bundledBinPath;
	}
}
