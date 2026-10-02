#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { constants, homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PixMemoryProfiler, parseRssKb, supervisePix } from "./pix-memory-profiler.mjs";

const execute = promisify(execFile);

export function parseProfileArgs(args) {
	const result = { thresholdMb: 1024, output: undefined, pixArgs: [] };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--") { result.pixArgs = args.slice(i + 1); break; }
		if (arg === "--help") { result.help = true; continue; }
		if (arg === "--threshold-mb") {
			const value = args[++i];
			if (!value || !/^\d+$/u.test(value) || Number(value) < 64 || Number(value) > 65536) {
				throw new Error("--threshold-mb must be an integer from 64 to 65536");
			}
			result.thresholdMb = Number(value);
		} else if (arg === "--output") {
			const value = args[++i];
			if (!value || value.startsWith("--")) throw new Error("--output needs a directory");
			result.output = resolve(value);
		} else throw new Error(`unknown profiler option: ${arg}; pass Pix arguments after --`);
	}
	return result;
}

export async function captureMacProcess(pid, directory, { index, signal }) {
	// Bounds apply even when Pix cannot service timers/signals on its main thread.
	for (const [name, command, args] of [
		["sample", "/usr/bin/sample", [String(pid), "1", "1"]],
		["vmmap", "/usr/bin/vmmap", ["-summary", String(pid)]],
	]) {
		if (signal.aborted) return;
		let output;
		try {
			const { stdout, stderr } = await execute(command, args, {
				signal, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
			});
			output = `${stdout}\n${stderr}`;
		} catch (error) {
			if (signal.aborted) return;
			output = `${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`;
		}
		await writeFile(join(directory, `${index}-${name}.txt`), output, { mode: 0o600 });
	}
}

export async function main(args = process.argv.slice(2)) {
	const options = parseProfileArgs(args);
	if (options.help) {
		console.log("Usage: node scripts/profile-pix-memory.mjs [--threshold-mb 1024] [--output DIR] -- [Pix arguments]\n" +
			"macOS only. RSS is sampled outside Pix; sample/vmmap are captured at the threshold.\n" +
			"For a freeze below the threshold: kill -USR1 <profiler PID> from another terminal.\n" +
			"Private diagnostics are saved under ~/.config/pi/memory-profiles/ by default.");
		return 0;
	}
	if (process.platform !== "darwin") throw new Error("this profiler requires macOS sample/vmmap");
	// Never overwrite another run's evidence, including a user-selected directory.
	const root = options.output ?? join(homedir(), ".config", "pi", "memory-profiles");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const directory = join(root, `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);
	await mkdir(directory, { mode: 0o700 });
	const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/pix.mjs", import.meta.url)), ...options.pixArgs], {
		stdio: "inherit",
	});
	const profiler = new PixMemoryProfiler({
		thresholdMb: options.thresholdMb,
		readRss: async (signal) => parseRssKb((await execute("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], {
			signal, timeout: 2000, killSignal: "SIGKILL", maxBuffer: 4096,
		})).stdout),
		writeEvent: (event) => appendFile(join(directory, "rss.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 }),
		capture: (request) => captureMacProcess(child.pid, directory, request),
	});
	const summary = await supervisePix(child, profiler, {
		onStarted: async () => {
			console.error(`[pix-memory] profiler PID ${process.pid}; Pix PID ${child.pid}; evidence: ${directory}`);
			await writeFile(join(directory, "run.json"), JSON.stringify({
				startedAt: new Date().toISOString(), monitorPid: process.pid, pixPid: child.pid,
				node: process.version, thresholdMb: options.thresholdMb,
			}, null, 2), { mode: 0o600 });
		},
		onMonitorError: (error) => console.error(`[pix-memory] diagnostic error: ${error}`),
		onSampleLimit: () => console.error("[pix-memory] sample limit reached; monitoring stopped, Pix is still running"),
	});
	await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 })
		.catch((error) => { summary.monitorError ??= error.message; });
	console.error(`[pix-memory] evidence: ${directory}${summary.monitorError ? `; monitor error: ${summary.monitorError}` : ""}`);
	return summary.code ?? (summary.signal ? 128 + (constants.signals[summary.signal] ?? 0) : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((code) => { process.exitCode = code; }).catch((error) => {
		console.error(`[pix-memory] ${error.message}`);
		process.exitCode = 1;
	});
}
