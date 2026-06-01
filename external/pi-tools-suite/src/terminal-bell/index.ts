import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const BELL = "\x07";
const DEFAULT_IDLE_DELAY_MS = 250;
const IDLE_RETRY_DELAY_MS = 100;
const MAX_IDLE_RETRIES = 40;
const SUBAGENTS_LIVE_COUNT_EVENT = "pi-tools-suite:async-subagents:live-count";
const DEFAULT_NOTIFICATION_TITLE = "Pi";
const DEFAULT_NOTIFICATION_MESSAGE = "Session stopped";
const DEFAULT_ASK_USER_NOTIFICATION_MESSAGE = "Waiting for your answer";
const DEFAULT_MAC_SOUND = "Glass";

const TERM_PROGRAM_BUNDLE_IDS: Record<string, string> = {
	Apple_Terminal: "com.apple.Terminal",
	iTerm: "com.googlecode.iterm2",
	"iTerm.app": "com.googlecode.iterm2",
	WezTerm: "com.github.wez.wezterm",
	WarpTerminal: "dev.warp.Warp-Stable",
	ghostty: "com.mitchellh.ghostty",
	Ghostty: "com.mitchellh.ghostty",
	kitty: "net.kovidgoyal.kitty",
	Alacritty: "org.alacritty",
	vscode: "com.microsoft.VSCode",
	"vscode-insiders": "com.microsoft.VSCodeInsiders",
	zed: "dev.zed.Zed",
};

type Timer = ReturnType<typeof setTimeout>;

type SubagentsLiveCountEvent = {
	count?: unknown;
};

function parseDelayMs(value: string | undefined): number {
	if (value === undefined || value.trim() === "") return DEFAULT_IDLE_DELAY_MS;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_DELAY_MS;
}

function isTruthyEnv(value: string | undefined): boolean {
	if (value === undefined) return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function extensionDisabled(): boolean {
	return isTruthyEnv(process.env.HEADLESS) || isTruthyEnv(process.env.PI_TERMINAL_BELL_DISABLED);
}

function canRingTerminal(): boolean {
	if (process.env.PI_TERMINAL_BELL === "0") return false;
	if (process.env.PI_TERMINAL_BELL_FORCE === "1") return true;
	return Boolean(process.stdout.isTTY || process.stderr.isTTY);
}

function writeBell(): void {
	const stream = process.stdout.isTTY || !process.stderr.isTTY ? process.stdout : process.stderr;
	stream.write(BELL);
}

function soundEnabled(ctx: ExtensionContext): boolean {
	if (process.env.PI_TERMINAL_BELL_SOUND === "0") return false;
	if (process.env.PI_TERMINAL_BELL_SOUND === "1") return true;
	return ctx.hasUI === true;
}

function notificationsEnabled(ctx: ExtensionContext): boolean {
	if (process.env.PI_TERMINAL_BELL_NOTIFY === "0") return false;
	if (process.env.PI_TERMINAL_BELL_NOTIFY === "1") return true;
	return ctx.hasUI === true;
}

function appleScriptString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function spawnDetached(command: string, args: string[]): void {
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
	} catch {
		// Best-effort user attention signal. Missing notification backends should not
		// affect the agent loop or suppress the terminal bell.
	}
}

function findExecutable(command: string): string | undefined {
	if (command.includes("/")) return existsSync(command) ? command : undefined;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, command);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function resolveMacSoundPath(sound: string): string {
	if (isAbsolute(sound)) return sound;
	const fileName = sound.endsWith(".aiff") ? sound : `${sound}.aiff`;
	return `/System/Library/Sounds/${fileName}`;
}

function detectMacActivationBundleId(): string | undefined {
	const explicit = process.env.PI_TERMINAL_BELL_NOTIFY_ACTIVATE;
	if (explicit === "0" || explicit === "false") return undefined;
	if (explicit && explicit.trim() !== "") return explicit.trim();

	// GUI apps that launch shells on macOS commonly export their own bundle id.
	// This catches Terminal.app, iTerm2, Zed's terminal, VS Code terminals, etc.
	const inheritedBundleId = process.env.__CFBundleIdentifier;
	if (inheritedBundleId && inheritedBundleId.trim() !== "") return inheritedBundleId.trim();

	const termProgram = process.env.TERM_PROGRAM;
	if (!termProgram) return undefined;
	return TERM_PROGRAM_BUNDLE_IDS[termProgram];
}

function playAttentionSound(ctx: ExtensionContext): void {
	if (!soundEnabled(ctx)) return;
	if (process.platform !== "darwin") return;
	const sound = process.env.PI_TERMINAL_BELL_SOUND && process.env.PI_TERMINAL_BELL_SOUND !== "1"
		? process.env.PI_TERMINAL_BELL_SOUND
		: DEFAULT_MAC_SOUND;
	const soundPath = resolveMacSoundPath(sound);
	if (!existsSync(soundPath)) return;
	spawnDetached("/usr/bin/afplay", [soundPath]);
}

function notifySessionStopped(
	ctx: ExtensionContext,
	macActivationBundleId: string | undefined,
	message = process.env.PI_TERMINAL_BELL_NOTIFY_MESSAGE ?? DEFAULT_NOTIFICATION_MESSAGE,
): void {
	if (!notificationsEnabled(ctx)) return;
	const title = process.env.PI_TERMINAL_BELL_NOTIFY_TITLE ?? DEFAULT_NOTIFICATION_TITLE;

	if (process.platform === "darwin") {
		const terminalNotifier = findExecutable(process.env.PI_TERMINAL_BELL_NOTIFIER ?? "terminal-notifier");
		if (terminalNotifier) {
			const args = ["-title", title, "-message", message];
			const activate = macActivationBundleId;
			if (activate) {
				args.push("-activate", activate);
				args.push("-execute", `/usr/bin/open -b ${shellSingleQuote(activate)}`);

				// Do not pass -sender by default. On recent macOS versions it can make the
				// notification look like it came from the target app, but then clicking the
				// “Show” button may be handled as that app's own notification instead of
				// terminal-notifier's -activate/-execute action.
				if (process.env.PI_TERMINAL_BELL_NOTIFY_SENDER === "1") {
					args.push("-sender", activate);
				}
			}
			spawnDetached(terminalNotifier, args);
			return;
		}

		// Bare osascript notifications are sent by Script Editor/osascript on macOS;
		// clicking them can open Script Editor's file picker. Keep that backend opt-in
		// and prefer terminal-notifier for clickable system notifications.
		if (process.env.PI_TERMINAL_BELL_NOTIFY_OSASCRIPT !== "1") return;
		spawnDetached("/usr/bin/osascript", [
			"-e",
			`display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`,
		]);
		return;
	}

	if (process.platform === "linux") {
		spawnDetached("notify-send", [title, message]);
	}
}

const ASK_USER_TOOL_NAMES = new Set(["ask_user", "ask_user_question", "question"]);

function isAskUserToolName(toolName: string): boolean {
	return ASK_USER_TOOL_NAMES.has(toolName);
}

function isSubagentsWaitTool(toolName: string, args: unknown): boolean {
	if (toolName === "async_subagents_wait") return true;
	if (toolName !== "subagents") return false;
	if (!args || typeof args !== "object") return false;
	const action = (args as { action?: unknown }).action;
	return typeof action === "string" && action.trim().toLowerCase() === "wait";
}

function normalizeLiveCount(event: SubagentsLiveCountEvent): number | undefined {
	if (typeof event.count !== "number" || !Number.isFinite(event.count)) return undefined;
	return Math.max(0, Math.floor(event.count));
}

export default function terminalBell(pi: ExtensionAPI) {
	if (extensionDisabled()) return;

	let timer: Timer | undefined;
	let lastCtx: ExtensionContext | undefined;
	let deferredUntilSubagentsFinish = false;
	let liveSubagentCount = 0;
	const activeSubagentWaitToolCallIds = new Set<string>();
	const notifiedAskUserToolCallIds = new Set<string>();
	const idleDelayMs = parseDelayMs(process.env.PI_TERMINAL_BELL_DELAY_MS);
	const macActivationBundleId = process.platform === "darwin" ? detectMacActivationBundleId() : undefined;

	function clearTimer(): void {
		if (!timer) return;
		clearTimeout(timer);
		timer = undefined;
	}

	function hasSubagentWork(): boolean {
		return liveSubagentCount > 0 || activeSubagentWaitToolCallIds.size > 0;
	}

	function notifyAttention(ctx: ExtensionContext, message?: string): void {
		if (canRingTerminal()) writeBell();
		playAttentionSound(ctx);
		notifySessionStopped(ctx, macActivationBundleId, message);
	}

	function attemptBell(ctx: ExtensionContext, attempt: number): void {
		timer = undefined;

		if (!ctx.isIdle()) {
			if (attempt < MAX_IDLE_RETRIES) scheduleBell(ctx, IDLE_RETRY_DELAY_MS, attempt + 1);
			return;
		}

		if (ctx.hasPendingMessages()) return;

		if (hasSubagentWork()) {
			deferredUntilSubagentsFinish = true;
			return;
		}

		deferredUntilSubagentsFinish = false;
		notifyAttention(ctx);
	}

	function scheduleBell(ctx: ExtensionContext, delayMs = idleDelayMs, attempt = 0): void {
		lastCtx = ctx;
		clearTimer();
		timer = setTimeout(() => attemptBell(ctx, attempt), delayMs);
		timer.unref?.();
	}

	function notifyAskUserWaiting(toolCallId: string, ctx: ExtensionContext): void {
		if (notifiedAskUserToolCallIds.has(toolCallId)) return;
		notifiedAskUserToolCallIds.add(toolCallId);
		notifyAttention(ctx, process.env.PI_TERMINAL_BELL_ASK_USER_NOTIFY_MESSAGE ?? DEFAULT_ASK_USER_NOTIFICATION_MESSAGE);
	}

	pi.events.on(SUBAGENTS_LIVE_COUNT_EVENT, (data: unknown) => {
		const event = data && typeof data === "object" ? data as SubagentsLiveCountEvent : {};
		const count = normalizeLiveCount(event);
		if (count === undefined) return;
		liveSubagentCount = count;
		if (count === 0 && deferredUntilSubagentsFinish && lastCtx) {
			scheduleBell(lastCtx);
		}
	});

	pi.on("agent_start", async () => {
		clearTimer();
		deferredUntilSubagentsFinish = false;
		activeSubagentWaitToolCallIds.clear();
		notifiedAskUserToolCallIds.clear();
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (isSubagentsWaitTool(event.toolName, event.args)) {
			activeSubagentWaitToolCallIds.add(event.toolCallId);
		}
		if (isAskUserToolName(event.toolName)) {
			notifyAskUserWaiting(event.toolCallId, ctx);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isAskUserToolName(event.toolName)) {
			notifyAskUserWaiting(event.toolCallId, ctx);
		}
	});

	pi.on("tool_execution_end", async (event) => {
		activeSubagentWaitToolCallIds.delete(event.toolCallId);
		notifiedAskUserToolCallIds.delete(event.toolCallId);
	});

	pi.on("agent_end", async (_event, ctx) => {
		scheduleBell(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearTimer();
		lastCtx = undefined;
		deferredUntilSubagentsFinish = false;
		liveSubagentCount = 0;
		activeSubagentWaitToolCallIds.clear();
		notifiedAskUserToolCallIds.clear();
	});
}
