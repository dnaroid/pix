import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type ShellCommandDeps = {
	spawn: typeof spawn;
	waitForReturnToPix: () => Promise<void>;
};

let deps: ShellCommandDeps = { spawn, waitForReturnToPix: waitForReturnToPixImpl };

export function setShellCommandTestDeps(overrides: Partial<ShellCommandDeps>): () => void {
	const previous = deps;
	deps = { ...deps, ...overrides };
	return () => {
		deps = previous;
	};
}

export type InteractiveShellCommandResult = {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
};

export type BangShellCommand = {
	command: string;
	interactive: boolean;
};

export type ChatShellCommandStream = "stdout" | "stderr";

export type ChatShellCommandHandlers = {
	onOutput?: (chunk: string, stream: ChatShellCommandStream) => void;
	onSettled?: (result: InteractiveShellCommandResult) => void;
};

export type RunningChatShellCommand = {
	pid?: number;
	done: Promise<InteractiveShellCommandResult>;
	writeInput(input: string): boolean;
	interrupt(): boolean;
	kill(signal?: NodeJS.Signals): boolean;
	endInput(): void;
};

export function bangShellCommandFromInput(text: string): BangShellCommand | undefined {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("!")) return undefined;
	const interactive = trimmed.startsWith("!!");
	return { command: trimmed.slice(interactive ? 2 : 1).trim(), interactive };
}

export function shellCommandFromBangInput(text: string): string | undefined {
	return bangShellCommandFromInput(text)?.command;
}

export function runChatShellCommand(
	command: string,
	cwd: string,
	handlers: ChatShellCommandHandlers = {},
): RunningChatShellCommand {
	let child: ChildProcessWithoutNullStreams;
	try {
		child = deps.spawn(command, {
			cwd,
			env: process.env,
			shell: shellOption(),
			stdio: "pipe",
			...(process.platform === "win32" ? {} : { detached: true }),
		});
	} catch (error) {
		return failedChatShellCommand(error, handlers);
	}

	let settled = false;
	let resolveDone: (result: InteractiveShellCommandResult) => void = () => {};
	const done = new Promise<InteractiveShellCommandResult>((resolve) => {
		resolveDone = resolve;
	});
	const settle = (result: InteractiveShellCommandResult): void => {
		if (settled) return;
		settled = true;
		handlers.onSettled?.(result);
		resolveDone(result);
	};

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => handlers.onOutput?.(chunk, "stdout"));
	child.stderr.on("data", (chunk: string) => handlers.onOutput?.(chunk, "stderr"));
	child.once("error", (error) => {
		settle({ exitCode: null, signal: null, error: error instanceof Error ? error.message : String(error) });
	});
	child.once("close", (exitCode, signal) => {
		settle({ exitCode, signal });
	});

	return {
		...(child.pid === undefined ? {} : { pid: child.pid }),
		done,
		writeInput: (input: string) => {
			if (child.stdin.destroyed || !child.stdin.writable) return false;
			try {
				child.stdin.write(input);
				return true;
			} catch {
				return false;
			}
		},
		interrupt: () => signalChildProcess(child, "SIGINT"),
		kill: (signal = "SIGTERM") => signalChildProcess(child, signal),
		endInput: () => {
			try {
				if (!child.stdin.destroyed && child.stdin.writable) child.stdin.end();
			} catch {
				// Closing stdin is best-effort during shell teardown.
			}
		},
	};
}

export async function runInteractiveShellCommand(command: string, cwd: string): Promise<InteractiveShellCommandResult> {
	const ignoreSigint = (): void => {};
	process.on("SIGINT", ignoreSigint);

	process.stdout.write(`\n$ ${command}\n\n`);
	try {
		const result = await spawnShellCommand(command, cwd);
		process.stdout.write(`\n[pix] ${formatInteractiveShellResult(result)}\n`);
		await deps.waitForReturnToPix();
		return result;
	} finally {
		process.off("SIGINT", ignoreSigint);
	}
}

export function formatShellCommandEntry(command: string, result: InteractiveShellCommandResult, prefix = "!"): string {
	if (result.error) return `Shell command failed to start: ${prefix}${command}\n${result.error}`;
	return `Shell command finished (${formatInteractiveShellResult(result)}): ${prefix}${command}`;
}

async function spawnShellCommand(command: string, cwd: string): Promise<InteractiveShellCommandResult> {
	try {
		const child = deps.spawn(command, {
			cwd,
			env: process.env,
			shell: shellOption(),
			stdio: "inherit",
		});

		return await new Promise<InteractiveShellCommandResult>((resolve) => {
			let settled = false;
			const settle = (result: InteractiveShellCommandResult): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};

			child.once("error", (error) => {
				settle({ exitCode: null, signal: null, error: error instanceof Error ? error.message : String(error) });
			});
			child.once("close", (exitCode, signal) => {
				settle({ exitCode, signal });
			});
		});
	} catch (error) {
		return { exitCode: null, signal: null, error: error instanceof Error ? error.message : String(error) };
	}
}

function failedChatShellCommand(error: unknown, handlers: ChatShellCommandHandlers): RunningChatShellCommand {
	const result: InteractiveShellCommandResult = { exitCode: null, signal: null, error: error instanceof Error ? error.message : String(error) };
	const done = Promise.resolve(result);
	queueMicrotask(() => handlers.onSettled?.(result));
	return {
		done,
		writeInput: () => false,
		interrupt: () => false,
		kill: () => false,
		endInput: () => {},
	};
}

function signalChildProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
	if (child.killed) return false;
	try {
		if (process.platform !== "win32" && child.pid !== undefined) {
			process.kill(-child.pid, signal);
			return true;
		}
		return child.kill(signal);
	} catch {
		try {
			return child.kill(signal);
		} catch {
			return false;
		}
	}
}

function shellOption(): boolean | string {
	return process.platform === "win32" ? true : process.env.SHELL || true;
}

function formatInteractiveShellResult(result: InteractiveShellCommandResult): string {
	if (result.error) return `failed to start: ${result.error}`;
	if (result.signal) return `terminated by ${result.signal}`;
	return `exit ${result.exitCode ?? 0}`;
}

async function waitForReturnToPixImpl(): Promise<void> {
	if (!process.stdin.isTTY || !process.stdin.readable) return;
	process.stdout.write("[pix] Press Enter to return to pix…");
	await new Promise<void>((resolve) => {
		const cleanup = (): void => {
			process.stdin.off("data", onData);
			resolve();
		};
		const onData = (): void => cleanup();
		process.stdin.once("data", onData);
		process.stdin.resume();
	});
}
