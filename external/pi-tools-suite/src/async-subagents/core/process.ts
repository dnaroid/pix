import { spawnSync } from "node:child_process";

export type ProcessSignal = "SIGTERM" | "SIGINT" | "SIGKILL";

export function terminateProcess(pid: number, signal: ProcessSignal): void {
	if (process.platform === "win32") {
		const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			timeout: 1_000,
			windowsHide: true,
		});
		if (!result.error && result.status === 0) return;
	}
	process.kill(pid, signal);
}

/** Signal a launcher-owned process group on POSIX (a process tree on Windows).
 * POSIX callers must create the child as a process-group leader. Descendants
 * that create their own group/session are NOT covered by this helper. */
export function terminateProcessTree(pid: number, signal: ProcessSignal): void {
	if (process.platform === "win32") {
		terminateProcess(pid, signal);
		return;
	}

	try {
		process.kill(-pid, signal);
	} catch (error) {
		const code = typeof error === "object" && error && "code" in error
			? String((error as { code?: unknown }).code)
			: undefined;
		if (code !== "ESRCH") throw error;
		// The owned group is already gone. Never fall back to a possibly reused PID.
	}
}
