/**
 * telegram-mirror: bidirectional Telegram mirror of the running pix session.
 *
 * Opt-in module configured via ~/.config/pi/pi-tools-suite.jsonc under the
 * `telegramMirror` key:
 *
 *   "telegramMirror": {
 *     "enabled": true,
 *     "botToken": "123456789:ABCdef...",   // from @BotFather
 *     "chatId": 123456789                   // numeric id allowed to control the bot
 *   }
 *
 * Self-disables when the section is missing, `enabled: false`, `botToken` is
 * empty, or `chatId` is not an integer.
 *
 * === Multi-instance architecture ===
 *
 * Telegram allows exactly one concurrent getUpdates call per bot token, so N
 * pi processes can't each poll the same bot. This module elects a leader:
 *
 *   - First pi to start binds `~/.pi/agent/extensions/pi-tools-suite/.run/
 *     telegram-mirror.sock`. It owns the TG polling loop and a Multiplexer
 *     that routes events/commands between Telegram and pi instances.
 *   - Subsequent pi processes connect to the socket as followers. They
 *     forward their pix events to the leader over IPC and execute commands
 *     received from the leader.
 *   - If the leader dies (socket close / heartbeat timeout), followers race
 *     to take over; the first to bind wins.
 *
 * See IPC protocol in `./ipc.ts` and routing logic in `./multiplexer.ts`.
 *
 * The user picks the active instance in Telegram with /list and /use N.
 * Events from non-active instances are dropped (silent).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadTelegramMirrorConfig } from "../config.js";
import { ignoreStaleExtensionContextError, isAgentBusyRaceError } from "../context-usage.js";
import { TelegramBot } from "./bot.js";
import { captureAbortableContext, registerPixEventHandlers, type PixMirrorHooks, type RendererSink } from "./events.js";
import { TurnRenderer, type RendererEvent } from "./renderer.js";
import {
	DEFAULT_SOCKET_PATH,
	IpcServer,
	IpcSocket,
	buildInstanceId,
	tryAcquireLeadership,
	updateInstanceInfo,
	type IpcMessage,
	type InstanceInfo,
} from "./ipc.js";
import { Multiplexer, type LocalDispatch } from "./multiplexer.js";

type Role = "starting" | "leader" | "follower";

interface MirrorContext {
	abort(): void;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	compact(): void;
	currentDialog(): string | undefined;
}

interface SessionSnapshot {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	sessionName?: string;
}

const RECONNECT_DELAY_MS = 2_000;
const COMMAND_NAME = "telegram-mirror";
const COMMAND_ALIAS = "tg";
const COMMAND_OFF = "tg-off";

export default function telegramMirror(pi: ExtensionAPI): void {
	const cfg = loadTelegramMirrorConfig();
	if (!cfg) {
		// Soft-disable: no logging at startup, the user hasn't configured
		// botToken/chatId yet. When the block exists, even with
		// enabled:false, still register /telegram-mirror and /tg so the
		// user can activate the bot explicitly by slash command.
		return;
	}

	const { botToken: token, chatId } = cfg;
	const { id: selfId, info: baseSelfInfo } = buildInstanceId();
	let selfInfo: InstanceInfo = baseSelfInfo;

	let role: Role = "starting";
	let bot: TelegramBot | undefined;
	let renderer: TurnRenderer | undefined;
	let multiplexer: Multiplexer | undefined;
	let server: IpcServer | undefined;
	let clientSocket: IpcSocket | undefined;
	let mirrorCtx: MirrorContext | undefined;
	let captureHooksInstalled = false;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let shutdown = false;
	let disabled = false;
	let activationRequested = false;

	const log = (message: string): void => {
		// eslint-disable-next-line no-console
		console.error(`[telegram-mirror] ${message}`);
	};

	function staleSafe<T>(callback: () => T, fallback?: T): T | undefined {
		try {
			return callback();
		} catch (error) {
			ignoreStaleExtensionContextError(error);
			return fallback;
		}
	}

	function sendUserMessageSafely(text: string): void {
		try {
			pi.sendUserMessage(text);
		} catch (error) {
			if (isAgentBusyRaceError(error)) {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
				return;
			}
			throw error;
		}
	}

	// Dispatch the leader uses to execute commands on its own pi session.
	const localDispatch: LocalDispatch = {
		sendUserMessage(text) {
			staleSafe(() => sendUserMessageSafely(text));
		},
			currentDialog() {
				return mirrorCtx?.currentDialog();
			},
			abort() {
				mirrorCtx?.abort();
			},
		compact() {
			mirrorCtx?.compact();
		},
		status() {
			const ctx = mirrorCtx;
			if (!ctx) return undefined;
			return {
				idle: staleSafe(() => ctx.isIdle(), true) ?? true,
				hasPending: staleSafe(() => ctx.hasPendingMessages(), false) ?? false,
			};
		},
	};

	// Renderer sink that routes events based on current role.
	const eventSink: RendererSink = {
		push(event: RendererEvent) {
			if (role === "leader" && multiplexer) {
				multiplexer.pushLocalEvent(event);
			} else if (role === "follower" && clientSocket && !clientSocket.isClosed) {
				clientSocket.send({ type: "event", from: selfId, event });
			}
			// starting / no IPC yet → drop; events between session_start and
			// IPC ready are lost (acceptable; rendering is lossy anyway).
		},
	};

	const hooks: PixMirrorHooks = {
		getRenderer: () => eventSink,
		describeInstance: (ctx) => describeInstance(ctx),
		notifyAgentEnd: () => undefined,
	};

	registerPixEventHandlers(pi, hooks);
	registerActivationCommand(COMMAND_NAME);
	registerActivationCommand(COMMAND_ALIAS);
	registerOffCommand();

	pi.on("session_start", async (_event, ctx) => {
		refreshCtx(ctx as ExtensionContext | undefined);
		refreshSelfInfo(ctx as ExtensionContext | undefined);
		if (!captureHooksInstalled) {
			captureHooksInstalled = true;
			captureAbortableContext(ctx as ExtensionContext | undefined, {
				captureAbort(fn) {
					mirrorCtx = mirrorCtx ?? makeCtx({ abort: fn });
					(mirrorCtx as Mutable<MirrorContext>).abort = fn;
				},
				captureIdle(fn) {
					mirrorCtx = mirrorCtx ?? makeCtx({ isIdle: fn });
					(mirrorCtx as Mutable<MirrorContext>).isIdle = fn;
				},
				capturePending(fn) {
					mirrorCtx = mirrorCtx ?? makeCtx({ hasPendingMessages: fn });
					(mirrorCtx as Mutable<MirrorContext>).hasPendingMessages = fn;
				},
				captureCompact(fn) {
					mirrorCtx = mirrorCtx ?? makeCtx({ compact: fn });
					(mirrorCtx as Mutable<MirrorContext>).compact = fn;
				},
			});
		}
		if (activationRequested) await start();
	});

	pi.on("agent_start", (_e, ctx) => {
		refreshCtx(ctx as ExtensionContext | undefined);
		refreshSelfInfo(ctx as ExtensionContext | undefined);
	});
	pi.on("before_agent_start", (_e, ctx) => {
		refreshCtx(ctx as ExtensionContext | undefined);
		refreshSelfInfo(ctx as ExtensionContext | undefined);
	});

	pi.on("session_shutdown", async (event) => {
		// On reload/fork the module will be reloaded in the same process —
		// keep IPC and bot alive so cluster leadership stays stable.
		if (event?.reason === "reload" || event?.reason === "fork") return;
		shutdown = true;
		await teardown();
	});

	async function start(): Promise<void> {
		activationRequested = true;
		if (shutdown) return;
		if (disabled) return;
		if (role !== "starting") return;
		if (reconnectTimer) return;

		try {
			const outcome = await tryAcquireLeadership(DEFAULT_SOCKET_PATH);
			if (outcome.role === "leader") {
				await becomeLeader(outcome.server);
			} else {
				becomeFollower(outcome.socket);
			}
		} catch (error) {
			log(`failed to acquire leadership: ${errorMessage(error)}`);
			scheduleReconnect();
		}
	}

	function scheduleReconnect(): void {
		if (shutdown) return;
		if (disabled) return;
		if (reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			void start();
		}, RECONNECT_DELAY_MS);
	}

	async function becomeLeader(server_: IpcServer): Promise<void> {
		role = "leader";
		server = server_;

		// Validate bot token before declaring leadership; if auth fails,
		// step down so another pi with a working config can try.
		let created: TelegramBot;
		try {
			created = new TelegramBot({ token, allowedChatId: chatId });
		} catch (error) {
			log(`failed to create bot: ${errorMessage(error)}`);
			await stepDown();
			return;
		}

		try {
			const me = await created.getMe();
			if (!me?.ok || !me.result) {
				log(`getMe rejected the token; stepping down`);
				created.abort();
				await stepDown();
				return;
			}
			await created.setMyCommands([
				{ command: "menu", description: "Choose project/session" },
				{ command: "list", description: "List pi sessions" },
				{ command: "use", description: "Follow a session by number" },
				{ command: "status", description: "Show followed session status" },
				{ command: "clear", description: "Clear known bot messages" },
				{ command: "abort", description: "Abort followed session" },
				{ command: "compact", description: "Compact followed session" },
				{ command: "disconnect", description: "Stop Telegram mirror" },
				{ command: "help", description: "Show help" },
			]).catch((error) => log(`setMyCommands failed: ${errorMessage(error)}`));
			bot = created;
			log(`connected as @${me.result.username} (leader) [${selfInfo.label}]`);
		} catch (error) {
			log(`getMe failed: ${errorMessage(error)}`);
			created.abort();
			await stepDown();
			return;
		}

		renderer = new TurnRenderer(bot, log);
		multiplexer = new Multiplexer({
			selfId,
			selfInfo,
			bot,
			renderer,
			server: server_,
			dispatch: localDispatch,
			standDown: clusterStandDown,
			log,
		});
			multiplexer.init();

			bot.startPolling(async (update) => {
				await multiplexer?.handleTelegramUpdate(update);
			});
			await bot.sendMessage(`✅ Telegram mirror active: ${selfInfo.label}`, {
				replyMarkup: { inline_keyboard: [[{ text: "🧭 Choose project/session", callback_data: "tg:list" }]] },
			}).catch((error) => log(`startup message failed: ${errorMessage(error)}`));
			await multiplexer.showActiveDialog();
		}

	function becomeFollower(socket: IpcSocket): void {
		role = "follower";
		clientSocket = socket;
		socket.send({ type: "register", info: selfInfo });

		socket.onMessage = (msg: IpcMessage) => {
			if (msg.type === "registered") {
				log(`registered with leader ${msg.leader.label} [${selfInfo.label}]`);
				return;
			}
			if (msg.type === "stand_down") {
				log(`received stand_down from leader; stopping`);
				disabled = true;
				if (reconnectTimer) {
					clearTimeout(reconnectTimer);
					reconnectTimer = undefined;
				}
				socket.close();
				return;
			}
			if (msg.type === "command") {
				void handleFollowerCommand(socket, msg.reqId, msg.command, msg.args);
				return;
			}
			if (msg.type === "query") {
				void handleFollowerQuery(socket, msg.reqId, msg.query);
				return;
			}
			// pings/pongs/acks handled in IpcSocket
		};

		socket.onClose = () => {
			log(`lost connection to leader; retrying in ${RECONNECT_DELAY_MS}ms`);
			clientSocket = undefined;
			role = "starting";
			scheduleReconnect();
		};

		socket.onError = (error) => {
			log(`ipc client error: ${error.message}`);
		};
	}

	async function handleFollowerCommand(socket: IpcSocket, reqId: string, command: string, args: unknown): Promise<void> {
		let ok = true;
		let error: string | undefined;
		try {
			switch (command) {
				case "sendUserMessage":
					staleSafe(() => sendUserMessageSafely(((args as { text?: string } | undefined)?.text ?? "")));
					break;
				case "abort":
					mirrorCtx?.abort();
					break;
				case "compact":
					mirrorCtx?.compact();
					break;
				default:
					ok = false;
					error = `unknown command: ${command}`;
			}
		} catch (err) {
			ok = false;
			error = errorMessage(err);
		}
		socket.send({ type: "command_ack", reqId, ok, error });
	}

		async function handleFollowerQuery(socket: IpcSocket, reqId: string, query: string): Promise<void> {
			if (query === "status") {
				const result = mirrorCtx
					? { idle: mirrorCtx.isIdle(), hasPending: mirrorCtx.hasPendingMessages() }
					: { idle: true, hasPending: false };
				socket.send({ type: "query_reply", reqId, ok: true, result });
				return;
			}
			if (query === "dialog") {
				socket.send({ type: "query_reply", reqId, ok: true, result: { text: mirrorCtx?.currentDialog() ?? "" } });
				return;
			}
			socket.send({ type: "query_reply", reqId, ok: false, error: `unknown query: ${query}` });
		}

	function registerActivationCommand(name: string): void {
		pi.registerCommand(name, {
			description: name === COMMAND_NAME ? "Start Telegram mirror and show connection status" : "Alias for /telegram-mirror",
			handler: async (args, ctx) => {
				refreshCtx(ctx as ExtensionContext | undefined);
				refreshSelfInfo(ctx as ExtensionContext | undefined);
				const trimmed = args.trim();
				if (trimmed === "status") {
					notify(ctx, localStatusText(), "info");
					return;
				}
				if (trimmed === "stop" || trimmed === "disconnect") {
					await clusterStandDown();
					notify(ctx, "Telegram mirror stopped. Run /telegram-mirror to start again.", "info");
					return;
				}
				disabled = false;
				activationRequested = true;
				await start();
				notify(ctx, localStatusText(), "info");
			},
		});
	}

	function registerOffCommand(): void {
		pi.registerCommand(COMMAND_OFF, {
			description: "Stop Telegram mirror cluster",
			handler: async (_args, ctx) => {
				await clusterStandDown();
				notify(ctx, "Telegram mirror stopped. Run /tg or /telegram-mirror to start again.", "info");
			},
		});
	}

	async function stepDown(): Promise<void> {
		role = "starting";
		if (server) {
			try {
				await server.close();
			} catch {
				// ignore
			}
			server = undefined;
		}
		scheduleReconnect();
	}

	/**
	 * Cluster-wide teardown triggered by `/disconnect` from Telegram.
	 *
	 * Leader: broadcast `stand_down` to every follower, wait briefly for
	 * delivery, then tear down bot + server. The socket file is unlinked
	 * in IpcServer.close so no follower can race into leadership after.
	 *
	 * Follower: just tear down local IPC. (Should not normally be reached
	 * from /disconnect because TG commands arrive at the leader only.)
	 *
	 * `disabled` is set BEFORE broadcast/teardown so that any subsequent
	 * socket close / reconnect attempt short-circuits and the cluster
	 * stays down until pi is /reload-ed (which re-runs this module
	 * factory and resets `disabled`).
	 */
	async function clusterStandDown(): Promise<void> {
		if (disabled) return;
		disabled = true;
		activationRequested = false;
		if (server && role === "leader") {
			try {
				server.broadcast({ type: "stand_down" });
			} catch (error) {
				log(`broadcast stand_down failed: ${errorMessage(error)}`);
			}
			// Give followers a moment to receive stand_down and set their
			// own `disabled` flag before we close the sockets.
			await new Promise<void>((resolve) => setTimeout(resolve, 200));
		}
		await teardown();
		log(`disconnected (/disconnect). /reload in pi to resume.`);
	}

	async function teardown(): Promise<void> {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
		}
		renderer?.reset();
		renderer = undefined;
		multiplexer?.close();
		multiplexer = undefined;
		if (bot) bot.abort();
		bot = undefined;
		if (clientSocket) clientSocket.close();
		clientSocket = undefined;
		if (server) {
			try {
				await server.close();
			} catch {
				// ignore
			}
			server = undefined;
		}
		role = "starting";
	}

	function refreshCtx(ctx: ExtensionContext | undefined): void {
		if (!ctx) return;
		if (!mirrorCtx) {
			mirrorCtx = makeCtx({
					abort: () => {
						staleSafe(() => ctx.abort());
					},
					isIdle: () => staleSafe(() => ctx.isIdle(), true) ?? true,
					hasPendingMessages: () => staleSafe(() => ctx.hasPendingMessages(), false) ?? false,
					compact: () => {
						staleSafe(() => ctx.compact());
					},
					currentDialog: () => currentDialogFromContext(ctx),
				});
			return;
		}
		const m = mirrorCtx as Mutable<MirrorContext>;
		m.abort = () => {
			staleSafe(() => ctx.abort());
		};
		m.isIdle = () => staleSafe(() => ctx.isIdle(), true) ?? true;
		m.hasPendingMessages = () => staleSafe(() => ctx.hasPendingMessages(), false) ?? false;
		m.compact = () => {
			staleSafe(() => ctx.compact());
		};
		m.currentDialog = () => currentDialogFromContext(ctx);
	}

	function refreshSelfInfo(ctx: ExtensionContext | undefined): void {
		const snapshot = sessionSnapshot(ctx);
		if (!snapshot) return;
		selfInfo = updateInstanceInfo(selfInfo, snapshot);
		multiplexer?.updateSelfInfo(selfInfo);
		if (role === "follower" && clientSocket && !clientSocket.isClosed) {
			clientSocket.send({ type: "instance_update", info: selfInfo });
		}
	}

	function describeInstance(ctx: ExtensionContext | undefined) {
		refreshSelfInfo(ctx);
		return {
			label: selfInfo.label,
			cwd: selfInfo.cwd,
			...(selfInfo.sessionId ? { sessionId: selfInfo.sessionId } : {}),
			...(selfInfo.sessionName ? { sessionName: selfInfo.sessionName } : {}),
		};
	}

	function localStatusText(): string {
		const status = role === "leader" ? "leader/polling" : role === "follower" ? "follower/connected" : "not connected";
		return `Telegram mirror: ${status}\n${selfInfo.label}${selfInfo.sessionName ? ` · ${selfInfo.sessionName}` : ""}`;
	}
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function makeCtx(seed: Partial<MirrorContext>): MirrorContext {
	return {
		abort: seed.abort ?? (() => undefined),
		isIdle: seed.isIdle ?? (() => true),
		hasPendingMessages: seed.hasPendingMessages ?? (() => false),
		compact: seed.compact ?? (() => undefined),
		currentDialog: seed.currentDialog ?? (() => undefined),
	};
}

const TRANSCRIPT_MAX_MESSAGES = 40;
const TRANSCRIPT_MAX_CHARS = 28_000;

function currentDialogFromContext(ctx: ExtensionContext | undefined): string | undefined {
	if (!ctx) return undefined;
	let branch: unknown[];
	try {
		const maybeBranch = ctx.sessionManager.getBranch?.();
		branch = Array.isArray(maybeBranch) ? maybeBranch : [...(maybeBranch ?? [])];
	} catch {
		return undefined;
	}

	const messages: { role: "user" | "assistant"; text: string }[] = [];
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const role = entry.message.role === "user" || entry.message.role === "assistant" ? entry.message.role : undefined;
		if (!role) continue;
		const text = stripDcpMarkers(visibleMessageText(entry.message.content, role)).trim();
		if (!text) continue;
		messages.push({ role, text });
	}
	if (messages.length === 0) return undefined;

	const selected: string[] = [];
	let used = 0;
	let omitted = 0;
	for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
		const formatted = formatDialogMessage(messages[idx]);
		if (selected.length >= TRANSCRIPT_MAX_MESSAGES || (used + formatted.length > TRANSCRIPT_MAX_CHARS && selected.length > 0)) {
			omitted = idx + 1;
			break;
		}
		selected.unshift(formatted);
		used += formatted.length;
	}
	return `${omitted > 0 ? `… ${omitted} earlier message(s) omitted …\n\n` : ""}${selected.join("\n\n")}`;
}

function formatDialogMessage(message: { role: "user" | "assistant"; text: string }): string {
	return `${message.role === "user" ? "👤 You" : "🤖 Pi"}\n${message.text}`;
}

function stripDcpMarkers(text: string): string {
	return text
		.split(/\r?\n/u)
		.map((line) => line.replace(DCP_MARKER_RE, "").trimEnd())
		.join("\n")
		.replace(/[ \t]+\n/gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

const DCP_MARKER_RE = /\[dcp(?:-[\w-]+)?\]:\s*#\s*\([^)]*\)/giu;

function visibleMessageText(value: unknown, role: "user" | "assistant"): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((item) => visibleContentBlockText(item, role)).filter(Boolean).join("\n");
	return visibleContentBlockText(value, role);
}

function visibleContentBlockText(value: unknown, role: "user" | "assistant"): string {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return "";
	const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
	if (type.includes("tool") || type.includes("thinking")) return "";
	if (typeof value.text === "string") return value.text;
	if (typeof value.content === "string") return value.content;
	if (Array.isArray(value.content)) return value.content.map((item) => visibleContentBlockText(item, role)).filter(Boolean).join("\n");
	if (role === "user" && (type.includes("image") || type.includes("file"))) return `[${type || "attachment"}]`;
	return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sessionSnapshot(ctx: ExtensionContext | undefined): SessionSnapshot | undefined {
	if (!ctx) return undefined;
	try {
		const manager = ctx.sessionManager;
		return {
			cwd: manager.getCwd?.() ?? ctx.cwd,
			...(manager.getSessionId?.() ? { sessionId: manager.getSessionId() } : {}),
			...(manager.getSessionFile?.() ? { sessionFile: manager.getSessionFile() } : {}),
			...(manager.getSessionName?.() ? { sessionName: manager.getSessionName() } : {}),
		};
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return undefined;
	}
}

function notify(ctx: { hasUI?: boolean; ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } }, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui?.notify?.(message, type);
	else console.error(`[telegram-mirror] ${message}`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
