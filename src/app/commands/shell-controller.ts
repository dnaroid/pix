import { createId } from "../id.js";
import {
	runChatShellCommand,
	type ChatShellCommandHandlers,
	type InteractiveShellCommandResult,
	type RunningChatShellCommand,
} from "./shell-command.js";
import type { Entry, SessionActivity } from "../types.js";

const SHELL_RENDER_THROTTLE_MS = 33;

type ShellEntry = Extract<Entry, { kind: "shell" }>;

type AppShellControllerDeps = {
	runChatShellCommand(command: string, cwd: string, handlers: ChatShellCommandHandlers): RunningChatShellCommand;
};

const defaultDeps: AppShellControllerDeps = { runChatShellCommand };

export type AppShellControllerHost = {
	readonly cwd: string;
	isRunning(): boolean;
	activeScopeKey(): string | undefined;
	addEntry(entry: Entry): void;
	touchEntry(entry: Entry): void;
	setStatus(status: string): void;
	setSessionActivity(activity: SessionActivity): void;
	restoreSessionStatus(): void;
	render(): void;
	scheduleRender(): void;
};

export class AppShellController {
	private activeRun: { entry: ShellEntry; command: RunningChatShellCommand; scopeKey: string | undefined } | undefined;
	private renderTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly host: AppShellControllerHost,
		private readonly deps: AppShellControllerDeps = defaultDeps,
	) {}

	isRunning(): boolean {
		return this.activeRun !== undefined && this.isScopeActive(this.activeRun.scopeKey);
	}

	async run(command: string): Promise<InteractiveShellCommandResult> {
		if (this.activeRun) throw new Error("A shell command is already running");
		const scopeKey = this.host.activeScopeKey();

		const entry: ShellEntry = {
			id: createId("shell"),
			kind: "shell",
			command,
			output: "",
			expanded: true,
			status: "running",
		};
		this.host.addEntry(entry);
		this.host.setStatus(`shell: ${command}`);
		this.host.setSessionActivity("running");
		this.host.render();

		const runningCommand = this.deps.runChatShellCommand(command, this.host.cwd, {
			onOutput: (chunk) => this.appendOutput(entry, chunk, scopeKey),
			onSettled: (result) => this.finishEntry(entry, result, scopeKey),
		});
		this.activeRun = { entry, command: runningCommand, scopeKey };

		try {
			return await runningCommand.done;
		} finally {
			if (this.activeRun?.entry === entry) this.activeRun = undefined;
			this.flushRender();
			if (this.isScopeActive(scopeKey)) {
				this.host.restoreSessionStatus();
				if (this.host.isRunning()) this.host.render();
			}
		}
	}

	sendInput(text: string): boolean {
		const activeRun = this.activeRun;
		if (!activeRun || !this.isScopeActive(activeRun.scopeKey)) return false;

		const input = text.endsWith("\n") ? text : `${text}\n`;
		this.appendInputEcho(activeRun.entry, input, activeRun.scopeKey);
		return activeRun.command.writeInput(input);
	}

	interrupt(): boolean {
		const activeRun = this.activeRun;
		if (!activeRun || !this.isScopeActive(activeRun.scopeKey)) return false;

		this.appendOutput(activeRun.entry, "\n^C\n", activeRun.scopeKey);
		return activeRun.command.interrupt();
	}

	dispose(): void {
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
		const activeRun = this.activeRun;
		this.activeRun = undefined;
		activeRun?.command.kill("SIGTERM");
	}

	private appendOutput(entry: ShellEntry, chunk: string, scopeKey: string | undefined): void {
		entry.output = appendTerminalChunk(entry.output, chunk);
		this.touchAndScheduleRender(entry, scopeKey);
	}

	private appendInputEcho(entry: ShellEntry, input: string, scopeKey: string | undefined): void {
		entry.output = appendTerminalChunk(entry.output, formatInputEcho(input));
		this.touchAndScheduleRender(entry, scopeKey);
	}

	private finishEntry(entry: ShellEntry, result: InteractiveShellCommandResult, scopeKey: string | undefined): void {
		entry.status = "done";
		entry.exitCode = result.exitCode;
		entry.signal = result.signal;
		if (result.error) entry.error = result.error;
		this.touchAndScheduleRender(entry, scopeKey);
	}

	private touchAndScheduleRender(entry: ShellEntry, scopeKey: string | undefined): void {
		if (!this.isScopeActive(scopeKey)) return;
		this.host.touchEntry(entry);
		if (!this.host.isRunning() || this.renderTimer) return;

		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.host.isRunning()) this.host.scheduleRender();
		}, SHELL_RENDER_THROTTLE_MS);
		this.renderTimer.unref?.();
	}

	private flushRender(): void {
		if (!this.renderTimer) return;
		clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
	}

	private isScopeActive(scopeKey: string | undefined): boolean {
		return this.host.activeScopeKey() === scopeKey;
	}
}

function appendTerminalChunk(current: string, chunk: string): string {
	let next = current;
	for (let index = 0; index < chunk.length;) {
		const codePoint = chunk.codePointAt(index) ?? 0;
		const char = String.fromCodePoint(codePoint);
		index += codePoint > 0xffff ? 2 : 1;

		if (char === "\r") {
			const lineStart = next.lastIndexOf("\n") + 1;
			next = next.slice(0, lineStart);
			continue;
		}

		next += char;
	}
	return next;
}

function formatInputEcho(input: string): string {
	const text = input.endsWith("\n") ? input.slice(0, -1) : input;
	const lines = text.split("\n");
	if (lines.length === 1 && lines[0] === "") return "\x1b[90m› Enter\x1b[0m\n";
	return `${lines.map((line, index) => `\x1b[90m${index === 0 ? "› " : "  "}${line}\x1b[0m`).join("\n")}\n`;
}
