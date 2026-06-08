import { spawn } from "node:child_process";

export type AsyncProcessResult = {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: Error;
	timedOut?: boolean;
};

export type RunProcessOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	input?: string;
	timeoutMs?: number;
	maxBufferBytes?: number;
};

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

export async function runProcess(command: string, args: readonly string[] = [], options: RunProcessOptions = {}): Promise<AsyncProcessResult> {
	const maxBufferBytes = Math.max(1, options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES);
	return new Promise<AsyncProcessResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let error: Error | undefined;
		let timedOut = false;
		let forceKillTimer: NodeJS.Timeout | undefined;

		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const append = (current: string, chunk: Buffer): string => {
			const next = `${current}${chunk.toString("utf8")}`;
			return next.length > maxBufferBytes ? next.slice(-maxBufferBytes) : next;
		};

		const timer = options.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
				forceKillTimer = setTimeout(() => {
					child.kill("SIGKILL");
				}, 3_000);
				forceKillTimer.unref?.();
			}, options.timeoutMs);
		timer?.unref?.();

		child.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		child.once("error", (err) => {
			error = err;
		});
		child.once("close", (status, signal) => {
			if (timer) clearTimeout(timer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			resolve({
				status,
				signal,
				stdout,
				stderr,
				...(error === undefined ? {} : { error }),
				...(timedOut ? { timedOut } : {}),
			});
		});

		if (options.input === undefined) child.stdin.end();
		else child.stdin.end(options.input);
	});
}

export async function commandExists(command: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	if (process.platform === "win32") {
		const names = [command, command.replace(/\.exe$/iu, ".cmd"), command.replace(/\.exe$/iu, ".bat")];
		for (const name of names) {
			const result = await runProcess("where", [name], { env, maxBufferBytes: 256 });
			if (result.status === 0) return true;
		}
		return false;
	}

	const result = await runProcess("sh", ["-lc", `command -v ${shellQuote(command)}`], { env, maxBufferBytes: 256 });
	return result.status === 0;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
