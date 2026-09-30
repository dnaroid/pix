import { execFile } from "node:child_process";
import type { RegistryExecutor } from "./context.js";

/** Git runs asynchronously in the ACP process, never in a Pi conversation. */
export const registryExecutor: RegistryExecutor = {
	exec(command, args, options) {
		return new Promise((resolve, reject) => {
			execFile(command, args, {
				cwd: options.cwd,
				timeout: options.timeout,
				maxBuffer: 16 * 1024 * 1024,
				encoding: "utf8",
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
			}, (error, stdout, stderr) => {
				if (error && (error.killed || typeof error.code !== "number")) { reject(error); return; }
				resolve({ stdout, stderr, code: error?.code as number ?? 0 });
			});
		});
	},
};
