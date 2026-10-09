import { spawn } from "node:child_process";

export async function runSelectionProcess(command: string, args: string[], options: {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs: number;
	killGraceMs?: number;
	onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
	const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	child.stdout.on("data", chunk => {
		const text = chunk.toString("utf8");
		stdout += text;
		options.onOutput?.("stdout", text);
	});
	child.stderr.on("data", chunk => {
		const text = chunk.toString("utf8");
		stderr += text;
		options.onOutput?.("stderr", text);
	});
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? 2_000);
		}, options.timeoutMs);
		function cleanup() {
			clearTimeout(timer);
			clearTimeout(killTimer);
		}
		child.once("error", error => { cleanup(); reject(error); });
		// Wait for termination and drained pipes before fixture cleanup or retry.
		child.once("close", code => { cleanup(); resolve(code); });
	});
	return { stdout, stderr, exitCode, timedOut };
}
