import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type PortableUpdateSwap = {
	parentPid: number;
	installRoot: string;
	stagedRoot: string;
	backupRoot: string;
	helperRoot: string;
	nodeRelativePath: string;
};

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

export async function waitForProcessExit(pid: number, timeoutMs = 120_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (processExists(pid)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for Pix process ${pid} to exit`);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
}

function validateSwapPaths(swap: PortableUpdateSwap): void {
	if (!Number.isSafeInteger(swap.parentPid) || swap.parentPid <= 0) throw new Error("Invalid updater parent PID");
	const installRoot = resolve(swap.installRoot);
	const stagedRoot = resolve(swap.stagedRoot);
	const backupRoot = resolve(swap.backupRoot);
	if (dirname(stagedRoot) !== dirname(installRoot) || dirname(backupRoot) !== dirname(installRoot)) {
		throw new Error("Updater staging and backup directories must be siblings of the installation");
	}
	if (installRoot === stagedRoot || installRoot === backupRoot || stagedRoot === backupRoot) {
		throw new Error("Updater paths must be distinct");
	}
	if (!/^runtime[\\/]node(?:\.exe)?$/u.test(swap.nodeRelativePath)) throw new Error("Invalid bundled Node path");
}

export async function swapPortableInstall(swap: PortableUpdateSwap): Promise<void> {
	validateSwapPaths(swap);
	await rm(swap.backupRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	await rename(swap.installRoot, swap.backupRoot);
	try {
		await rename(swap.stagedRoot, swap.installRoot);
	} catch (error) {
		try {
			await rename(swap.backupRoot, swap.installRoot);
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "Pix update failed and rollback could not restore the previous installation");
		}
		throw error;
	}
	await rm(swap.backupRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

function scheduleHelperCleanup(swap: PortableUpdateSwap): void {
	const node = join(swap.installRoot, swap.nodeRelativePath);
	const code = [
		"const { rmSync } = require('node:fs');",
		`setTimeout(() => { try { rmSync(${JSON.stringify(swap.helperRoot)}, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {} }, 250);`,
	].join("\n");
	try {
		spawn(node, ["-e", code], {
			cwd: dirname(swap.installRoot),
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		}).unref();
	} catch {
		// A successful install is more important than cleaning the temporary helper.
	}
}

export async function runPortableUpdateHelper(configPath: string): Promise<void> {
	const swap = JSON.parse(await readFile(configPath, "utf8")) as PortableUpdateSwap;
	validateSwapPaths(swap);
	await waitForProcessExit(swap.parentPid);
	// Give a Windows .cmd launcher that was waiting on the Node child a chance to
	// return before renaming its directory. The helper itself runs outside it.
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
	try {
		await swapPortableInstall(swap);
		scheduleHelperCleanup(swap);
	} catch (error) {
		await writeFile(join(swap.helperRoot, "update-error.txt"), `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`).catch(() => undefined);
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	const configPath = process.argv[2];
	if (!configPath) throw new Error("Missing portable updater helper config path");
	await runPortableUpdateHelper(configPath);
}
