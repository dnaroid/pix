import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

const BELL = "\x07";
const DEFAULT_IDLE_DELAY_MS = 250;
const IDLE_RETRY_DELAY_MS = 100;
const MAX_IDLE_RETRIES = 40;
const SUBAGENTS_LIVE_COUNT_EVENT = "pi-tools-suite:async-subagents:live-count";
const TERMINAL_BELL_ATTENTION_EVENT = "pix:terminal-bell:attention";
/**
 * Renderer-relayed signal that the session is in an auto-retry cycle.
 * Payload: `{ active: boolean }`. The SDK does not forward retry state to
 * extensions, so the renderer emits this on the extension event bus.
 */
const RETRY_ACTIVE_EVENT = "pix:retry-active";
const DEFAULT_COMPLETION_NOTIFICATION_TITLE = "Pix - completion";
const DEFAULT_ERROR_NOTIFICATION_TITLE = "Pix - error";
const DEFAULT_QUESTION_NOTIFICATION_TITLE = "Pix - question";
const DEFAULT_NOTIFICATION_MESSAGE = "{sessionName}";
const DEFAULT_RETRY_FAILED_NOTIFICATION_MESSAGE = "{sessionName}";
const DEFAULT_ASK_USER_NOTIFICATION_MESSAGE = "{sessionName}";
const DEFAULT_MAC_SOUND = "Glass";
const TERMINAL_BELL_CONFIG_KEY = "terminalBell";
const SOUND_CONFIG_KEY = "sound";
const TELEGRAM_CONFIG_KEY = "telegram";
const TELEGRAM_BOT_TOKEN_CONFIG_KEY = "botToken";
const TELEGRAM_CHAT_ID_CONFIG_KEY = "chatId";
const TELEGRAM_API_BASE = "https://api.telegram.org";

type TelegramConfig = {
	botToken?: string;
	chatId?: string;
};

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

type AgentEndRetryState = {
	willRetry?: unknown;
};

type AssistantMessageUpdateLike = {
	type?: unknown;
	error?: {
		errorMessage?: unknown;
	};
};

type NotificationTemplateValues = {
	sessionId: string;
	sessionName?: string;
	sessionTitle: string;
	sessionFile: string;
	sessionFileBase: string;
	cwd: string;
	reason?: string;
};

type NotificationContextSnapshot = {
	hasUI: boolean;
	templateValues: NotificationTemplateValues;
};

type PendingBell = {
	ctx: ExtensionContext;
	notification: NotificationContextSnapshot;
	message?: string;
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

function getPiToolsSuiteUserConfigPath(homeDir = homedir()): string {
	return join(homeDir, ".config", "pi", "pi-tools-suite.jsonc");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readTerminalBellSoundConfig(configPath = getPiToolsSuiteUserConfigPath()): boolean | undefined {
	if (!existsSync(configPath)) return undefined;
	try {
		const parsed = parseJsonc(readFileSync(configPath, "utf-8")) as unknown;
		if (!isRecord(parsed)) return undefined;
		const terminalBell = parsed[TERMINAL_BELL_CONFIG_KEY];
		if (!isRecord(terminalBell)) return undefined;
		const sound = terminalBell[SOUND_CONFIG_KEY];
		return typeof sound === "boolean" ? sound : undefined;
	} catch {
		return undefined;
	}
}

export function readTerminalBellTelegramConfig(configPath = getPiToolsSuiteUserConfigPath()): TelegramConfig {
	if (!existsSync(configPath)) return {};
	try {
		const parsed = parseJsonc(readFileSync(configPath, "utf-8")) as unknown;
		if (!isRecord(parsed)) return {};
		const terminalBell = parsed[TERMINAL_BELL_CONFIG_KEY];
		if (!isRecord(terminalBell)) return {};
		const telegram = terminalBell[TELEGRAM_CONFIG_KEY];
		if (!isRecord(telegram)) return {};
		const botToken = telegram[TELEGRAM_BOT_TOKEN_CONFIG_KEY];
		const chatId = telegram[TELEGRAM_CHAT_ID_CONFIG_KEY];
		return buildTelegramConfig(
			typeof botToken === "string" ? botToken.trim() : undefined,
			typeof chatId === "string" ? chatId.trim() : undefined,
		);
	} catch {
		return {};
	}
}

export function resolveTerminalBellTelegramConfig(configPath = getPiToolsSuiteUserConfigPath()): TelegramConfig {
	const fromConfig = readTerminalBellTelegramConfig(configPath);
	return buildTelegramConfig(
		trimmed(process.env.PI_TERMINAL_BELL_TELEGRAM_BOT_TOKEN) ?? fromConfig.botToken,
		trimmed(process.env.PI_TERMINAL_BELL_TELEGRAM_CHAT_ID) ?? fromConfig.chatId,
	);
}

function buildTelegramConfig(botToken: string | undefined, chatId: string | undefined): TelegramConfig {
	const config: TelegramConfig = {};
	if (botToken) config.botToken = botToken;
	if (chatId) config.chatId = chatId;
	return config;
}

export function terminalBellTelegramEnabled(configPath = getPiToolsSuiteUserConfigPath()): boolean {
	if (process.env.PI_TERMINAL_BELL_TELEGRAM === "0") return false;
	const { botToken, chatId } = resolveTerminalBellTelegramConfig(configPath);
	return Boolean(botToken && chatId);
}

export function terminalBellSoundEnabled(ctx: Pick<ExtensionContext, "hasUI">, configPath = getPiToolsSuiteUserConfigPath()): boolean {
	if (process.env.PI_TERMINAL_BELL_SOUND === "0") return false;
	if (process.env.PI_TERMINAL_BELL_SOUND === "1") return true;
	const configured = readTerminalBellSoundConfig(configPath);
	if (configured !== undefined) return configured;
	return ctx.hasUI === true;
}

export function terminalBellNotificationsEnabled(ctx: Pick<ExtensionContext, "hasUI">, configPath = getPiToolsSuiteUserConfigPath()): boolean {
	if (!terminalBellSoundEnabled(ctx, configPath)) return false;
	if (process.env.PI_TERMINAL_BELL_NOTIFY === "0") return false;
	if (process.env.PI_TERMINAL_BELL_NOTIFY === "1") return true;
	return ctx.hasUI === true;
}

export function canRingTerminal(ctx: Pick<ExtensionContext, "hasUI">, configPath = getPiToolsSuiteUserConfigPath()): boolean {
	if (!terminalBellSoundEnabled(ctx, configPath)) return false;
	if (process.env.PI_TERMINAL_BELL === "0") return false;
	if (process.env.PI_TERMINAL_BELL_FORCE === "1") return true;
	return Boolean(process.stdout.isTTY || process.stderr.isTTY);
}

function writeBell(): void {
	const stream = process.stdout.isTTY || !process.stderr.isTTY ? process.stdout : process.stderr;
	stream.write(BELL);
}

function appleScriptString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function trimmed(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && /ctx is stale|stale ctx|stale after session replacement|stale after.*reload/i.test(error.message);
}

function safeSessionName(ctx: ExtensionContext, pi?: Pick<ExtensionAPI, "getSessionName">): string | undefined {
	try {
		return trimmed(pi?.getSessionName?.() ?? ctx.sessionManager.getSessionName?.());
	} catch (error) {
		if (isStaleExtensionContextError(error)) return undefined;
		throw error;
	}
}

function buildNotificationTemplateValues(ctx: ExtensionContext, pi?: Pick<ExtensionAPI, "getSessionName">): NotificationTemplateValues {
	const sessionId = ctx.sessionManager.getSessionId();
	const sessionName = safeSessionName(ctx, pi);
	const sessionFile = ctx.sessionManager.getSessionFile() ?? "";
	return {
		sessionId,
		...(sessionName === undefined ? {} : { sessionName }),
		sessionTitle: sessionName ?? sessionId.slice(0, 8),
		sessionFile,
		sessionFileBase: basename(sessionFile),
		cwd: ctx.cwd,
	};
}

function buildNotificationContextSnapshot(ctx: ExtensionContext, pi?: Pick<ExtensionAPI, "getSessionName">): NotificationContextSnapshot | undefined {
	try {
		return {
			hasUI: ctx.hasUI === true,
			templateValues: buildNotificationTemplateValues(ctx, pi),
		};
	} catch (error) {
		if (isStaleExtensionContextError(error)) return undefined;
		throw error;
	}
}

function renderNotificationTemplate(template: string, values: NotificationTemplateValues, appendReasonIfUnused = false): string {
	let usedReason = false;
	const rendered = template.replace(/\{(sessionId|sessionName|sessionTitle|sessionFile|sessionFileBase|cwd|reason)\}/g, (_match, key: keyof NotificationTemplateValues) => {
		if (key === "reason") usedReason = true;
		return values[key] ?? "";
	});
	if (appendReasonIfUnused && values.reason && !usedReason) return `${rendered}: ${values.reason}`;
	return rendered;
}

function retryFailureMessageTemplate(): string {
	const configured = trimmed(process.env.PI_TERMINAL_BELL_NOTIFY_MESSAGE);
	return configured ?? DEFAULT_RETRY_FAILED_NOTIFICATION_MESSAGE;
}

function notificationTitleTemplate(defaultTitle: string): string {
	return process.env.PI_TERMINAL_BELL_NOTIFY_TITLE ?? defaultTitle;
}

function willRetryAfterAgentEnd(event: AgentEndRetryState): boolean {
	return event.willRetry === true;
}

function failureReasonFromMessageUpdate(event: AssistantMessageUpdateLike): string | undefined {
	if (event.type !== "error") return undefined;
	const reason = event.error?.errorMessage;
	return typeof reason === "string" ? trimmed(reason) : undefined;
}

function isNonErrorMessageUpdate(event: AssistantMessageUpdateLike): boolean {
	return typeof event.type === "string" && event.type !== "error";
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

function playAttentionSoundFor(context: Pick<ExtensionContext, "hasUI">): void {
	if (!terminalBellSoundEnabled(context)) return;
	if (process.platform !== "darwin") return;
	const sound = process.env.PI_TERMINAL_BELL_SOUND && process.env.PI_TERMINAL_BELL_SOUND !== "1"
		? process.env.PI_TERMINAL_BELL_SOUND
		: DEFAULT_MAC_SOUND;
	const soundPath = resolveMacSoundPath(sound);
	if (!existsSync(soundPath)) return;
	spawnDetached("/usr/bin/afplay", [soundPath]);
}

function sendTelegramNotification(title: string, message: string): void {
	if (process.env.PI_TERMINAL_BELL_TELEGRAM === "0") return;
	const { botToken, chatId } = resolveTerminalBellTelegramConfig();
	if (!botToken || !chatId) return;

	// Telegram is delivered independently of the bundled desktop sound/notification
	// gate, so it works even when terminalBell.sound is false. Compose a single text
	// body from the already-rendered title/message used by desktop notifications.
	const text = message ? `${title}\n${message}` : title;
	const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;

	try {
		fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: chatId,
				text,
				disable_web_page_preview: true,
			}),
		}).then(
			() => {
				// Best-effort delivery; ignore the response body.
			},
			() => {
				// Network/API failures must not affect the agent loop or suppress the
				// terminal bell / desktop notification.
			},
		);
	} catch {
		// fetch may be unavailable or throw synchronously; ignore.
	}
}

function notifySessionStopped(
	context: NotificationContextSnapshot,
	macActivationBundleId: string | undefined,
	options: { title: string; message?: string },
): void {
	const templateValues = context.templateValues;
	const title = renderNotificationTemplate(notificationTitleTemplate(options.title), templateValues);
	const renderedMessage = renderNotificationTemplate(options.message ?? process.env.PI_TERMINAL_BELL_NOTIFY_MESSAGE ?? DEFAULT_NOTIFICATION_MESSAGE, templateValues);

	// Telegram is independent of the bundled desktop sound/notification gate.
	sendTelegramNotification(title, renderedMessage);

	if (!terminalBellNotificationsEnabled(context)) return;

	if (process.platform === "darwin") {
		const terminalNotifier = findExecutable(process.env.PI_TERMINAL_BELL_NOTIFIER ?? "terminal-notifier");
		if (terminalNotifier) {
			const args = ["-title", title, "-message", renderedMessage];
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
			`display notification ${appleScriptString(renderedMessage)} with title ${appleScriptString(title)}`,
		]);
		return;
	}

	if (process.platform === "linux") {
		spawnDetached("notify-send", [title, renderedMessage]);
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
	let pendingBell: PendingBell | undefined;
	let deferredUntilSubagentsFinish = false;
	let liveSubagentCount = 0;
	let lastFailureReason: string | undefined;
	// True while the session is in an auto-retry cycle (relayed via the
	// extension event bus). Suppresses the failure bell on intermediate retry
	// attempts; the final exhausted failure still rings because no retry-start
	// signal precedes it.
	let retryActive = false;
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

	function notifyAttention(notification: NotificationContextSnapshot, message?: string): void {
		if (canRingTerminal(notification)) writeBell();
		playAttentionSoundFor(notification);
		notifySessionStopped(notification, macActivationBundleId, {
			title: message ? DEFAULT_ERROR_NOTIFICATION_TITLE : DEFAULT_COMPLETION_NOTIFICATION_TITLE,
			...(message ? { message } : {}),
		});
		pi.events.emit(TERMINAL_BELL_ATTENTION_EVENT, {
			cwd: notification.templateValues.cwd,
			sessionFile: notification.templateValues.sessionFile,
			sessionId: notification.templateValues.sessionId,
		});
	}

	function attemptBell(pending: PendingBell, attempt: number): void {
		timer = undefined;
		const { ctx, notification, message } = pending;

		// Safety net: if a retry-start signal arrives between the agent_end that
		// queued this bell and the timer firing, suppress the bell entirely.
		if (retryActive) return;

		try {
			if (!ctx.isIdle()) {
				if (attempt < MAX_IDLE_RETRIES) scheduleBell(ctx, IDLE_RETRY_DELAY_MS, attempt + 1, message, notification);
				return;
			}

			if (ctx.hasPendingMessages()) return;
		} catch (error) {
			if (isStaleExtensionContextError(error)) {
				pendingBell = undefined;
				deferredUntilSubagentsFinish = false;
				return;
			}
			throw error;
		}

		if (hasSubagentWork()) {
			deferredUntilSubagentsFinish = true;
			return;
		}

		deferredUntilSubagentsFinish = false;
		notifyAttention(notification, message);
	}

	function scheduleBell(
		ctx: ExtensionContext,
		delayMs = idleDelayMs,
		attempt = 0,
		message?: string,
		notification = buildNotificationContextSnapshot(ctx, pi),
	): void {
		if (!notification) return;
		pendingBell = { ctx, notification, ...(message ? { message } : {}) };
		clearTimer();
		timer = setTimeout(() => {
			if (!pendingBell) return;
			try {
				attemptBell(pendingBell, attempt);
			} catch (error) {
				if (isStaleExtensionContextError(error)) {
					pendingBell = undefined;
					deferredUntilSubagentsFinish = false;
					return;
				}
				throw error;
			}
		}, delayMs);
		timer.unref?.();
	}

	function notifyAskUserWaiting(toolCallId: string, ctx: ExtensionContext): void {
		if (notifiedAskUserToolCallIds.has(toolCallId)) return;
		notifiedAskUserToolCallIds.add(toolCallId);
		const notification = buildNotificationContextSnapshot(ctx, pi);
		if (!notification) return;
		if (canRingTerminal(notification)) writeBell();
		playAttentionSoundFor(notification);
		notifySessionStopped(notification, macActivationBundleId, {
			title: DEFAULT_QUESTION_NOTIFICATION_TITLE,
			message: process.env.PI_TERMINAL_BELL_ASK_USER_NOTIFY_MESSAGE ?? DEFAULT_ASK_USER_NOTIFICATION_MESSAGE,
		});
		pi.events.emit(TERMINAL_BELL_ATTENTION_EVENT, {
			cwd: notification.templateValues.cwd,
			sessionFile: notification.templateValues.sessionFile,
			sessionId: notification.templateValues.sessionId,
		});
	}

	pi.events.on(SUBAGENTS_LIVE_COUNT_EVENT, (data: unknown) => {
		const event = data && typeof data === "object" ? data as SubagentsLiveCountEvent : {};
		const count = normalizeLiveCount(event);
		if (count === undefined) return;
		liveSubagentCount = count;
		if (count === 0 && deferredUntilSubagentsFinish && pendingBell) {
			scheduleBell(pendingBell.ctx, idleDelayMs, 0, pendingBell.message, pendingBell.notification);
		}
	});

	pi.events.on(RETRY_ACTIVE_EVENT, (data: unknown) => {
		retryActive = data != null && typeof data === "object" && (data as { active?: unknown }).active === true;
		if (retryActive) {
			// A retry is starting right after an intermediate agent_end: cancel
			// any bell queued from that attempt so we don't chime on every
			// failed retry attempt. The final exhausted failure rings normally
			// because it is not followed by a retry-start signal.
			clearTimer();
			pendingBell = undefined;
			deferredUntilSubagentsFinish = false;
		}
	});

	pi.on("agent_start", async () => {
		clearTimer();
		deferredUntilSubagentsFinish = false;
		lastFailureReason = undefined;
		retryActive = false;
		activeSubagentWaitToolCallIds.clear();
		notifiedAskUserToolCallIds.clear();
	});

	pi.on("message_update", async (event) => {
		const reason = failureReasonFromMessageUpdate(event.assistantMessageEvent as AssistantMessageUpdateLike);
		if (reason) {
			lastFailureReason = reason;
			return;
		}
		if (isNonErrorMessageUpdate(event.assistantMessageEvent as AssistantMessageUpdateLike)) {
			lastFailureReason = undefined;
		}
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

	pi.on("agent_end", async (event, ctx) => {
		if (willRetryAfterAgentEnd(event as AgentEndRetryState)) {
			clearTimer();
			return;
		}
		if (lastFailureReason) {
			scheduleBell(
				ctx,
				idleDelayMs,
				0,
				renderNotificationTemplate(retryFailureMessageTemplate(), {
					...buildNotificationTemplateValues(ctx, pi),
					reason: lastFailureReason,
				}, true),
			);
			return;
		}
		scheduleBell(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearTimer();
		pendingBell = undefined;
		deferredUntilSubagentsFinish = false;
		liveSubagentCount = 0;
		lastFailureReason = undefined;
		retryActive = false;
		activeSubagentWaitToolCallIds.clear();
		notifiedAskUserToolCallIds.clear();
	});
}
