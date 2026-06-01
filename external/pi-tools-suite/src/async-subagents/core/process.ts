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
