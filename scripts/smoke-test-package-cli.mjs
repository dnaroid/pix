#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
let workDir;
let tarballPath;

function run(command, args, options = {}) {
	execFileSync(command, args, {
		cwd: repoRoot,
		stdio: "inherit",
		env: process.env,
		...options,
	});
}

function runPix(entryPath, args, extraEnv = {}) {
	execFileSync(process.execPath, [entryPath, ...args], {
		cwd: workDir,
		stdio: "inherit",
		env: { ...process.env, ...extraEnv },
	});
}

try {
	console.log("Building Pix...");
	run(npmExecutable, ["run", "build:pix"]);

	console.log("Packing npm tarball...");
	const packOutput = execFileSync(
		npmExecutable,
		["pack", "--pack-destination", repoRoot],
		{ cwd: repoRoot, encoding: "utf8", env: process.env },
	);
	const tarballName = packOutput.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
	if (!tarballName) throw new Error("npm pack did not report a tarball name");
	tarballPath = path.join(repoRoot, tarballName);
	if (!fs.existsSync(tarballPath)) throw new Error(`npm pack did not create ${tarballPath}`);

	console.log("Installing packed artifact in an isolated directory...");
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ui-extend-cli-smoke-"));
	fs.writeFileSync(
		path.join(workDir, "package.json"),
		'{ "name": "pix-cli-smoke-test", "private": true, "version": "0.0.0" }\n',
		"utf8",
	);
	run(npmExecutable, ["install", "--prefix", workDir, tarballPath, "--ignore-scripts", "--no-save"]);

	const packageRoot = path.join(workDir, "node_modules", "pi-ui-extend");
	const entryPath = path.join(packageRoot, "bin", "pix.mjs");
	const builtEntryPath = path.join(packageRoot, "dist", "main.js");
	if (!fs.existsSync(entryPath)) throw new Error(`Pix entry point is missing from the packed artifact: ${entryPath}`);
	if (!fs.existsSync(builtEntryPath)) throw new Error(`Pix build output is missing from the packed artifact: ${builtEntryPath}`);

	console.log("Running installed CLI sanity checks...");
	runPix(entryPath, ["--help"]);
	runPix(entryPath, ["update", "--help"]);
	runPix(entryPath, ["install", "--help"]);
	runPix(entryPath, ["update", "--check"], { PI_OFFLINE: "1" });

	console.log("Packed CLI sanity check passed.");
} finally {
	if (workDir) fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	if (tarballPath) fs.rmSync(tarballPath, { force: true, maxRetries: 10, retryDelay: 100 });
}
