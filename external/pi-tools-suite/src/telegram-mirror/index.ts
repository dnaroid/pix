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
import { TelegramBot } from "./bot.js";
import { captureAbortableContext, registerPixEventHandlers, type PixMirrorHooks, type RendererSink } from "./events.js";
import { TurnRenderer, type RendererEvent } from "./renderer.js";
import {
	DEFAULT_SOCKET_PATH,
	IpcServer,
	IpcSocket,
	buildInstanceId,
	tryAcquireLeadership,
	type IpcMessage,
} from "./ipc.js";
import { Multiplexer, type LocalDispatch } from "./multiplexer.js";

type Role = "starting" | "leader" | "follower";

interface MirrorContext {
	abort(): void;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	compact(): void;
}

const RECONNECT_DELAY_MS = 2_000;

export default function telegramMirror(pi: ExtensionAPI): void {
	const cfg = loadTelegramMirrorConfig();
	if (!cfg || !cfg.enabled) {
		// Soft-disable: no logging at startup, the user simply hasn't opted in.
		return;
	}

	const { botToken: token, chatId } = cfg;
	const { id: selfId, info: selfInfo } = buildInstanceId();

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

	const log = (message: string): void => {
		// eslint-disable-next-line no-console
		console.error(`[telegram-mirror] ${message}`);
	};

	// Dispatch the leader uses to execute commands on its own pi session.
	const localDispatch: LocalDispatch = {
		sendUserMessage(text) {
			pi.sendUserMessage(text);
		},
		abort() {
			mirrorCtx?.abort();
		},
		compact() {
			mirrorCtx?.compact();
		},
		status() {
			if (!mirrorCtx) return undefined;
			return { idle: mirrorCtx.isIdle(), hasPending: mirrorCtx.hasPendingMessages() };
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
		notifyAgentEnd: () => undefined,
	};

	registerPixEventHandlers(pi, hooks);

	pi.on("session_start", async (_event, ctx) => {
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
		await start();
	});

	pi.on("agent_start", (_e, ctx) => refreshCtx(ctx as ExtensionContext | undefined));
	pi.on("before_agent_start", (_e, ctx) => refreshCtx(ctx as ExtensionContext | undefined));

	pi.on("session_shutdown", async (event) => {
		// On reload/fork the module will be reloaded in the same process —
		// keep IPC and bot alive so cluster leadership stays stable.
		if (event?.reason === "reload" || event?.reason === "fork") return;
		shutdown = true;
		await teardown();
	});

	async function start(): Promise<void> {
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
			const text = update.message?.text;
			if (typeof text !== "string") return;
			if (!update.message?.chat || !bot?.isAllowedChat(update.message.chat.id)) return;
			await multiplexer?.handleTgText(text);
		});
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
					pi.sendUserMessage(((args as { text?: string } | undefined)?.text ?? ""));
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
		socket.send({ type: "query_reply", reqId, ok: false, error: `unknown query: ${query}` });
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
				abort: () => ctx.abort(),
				isIdle: () => ctx.isIdle(),
				hasPendingMessages: () => ctx.hasPendingMessages(),
				compact: () => ctx.compact(),
			});
			return;
		}
		const m = mirrorCtx as Mutable<MirrorContext>;
		m.abort = () => ctx.abort();
		m.isIdle = () => ctx.isIdle();
		m.hasPendingMessages = () => ctx.hasPendingMessages();
		m.compact = () => ctx.compact();
	}
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function makeCtx(seed: Partial<MirrorContext>): MirrorContext {
	return {
		abort: seed.abort ?? (() => undefined),
		isIdle: seed.isIdle ?? (() => true),
		hasPendingMessages: seed.hasPendingMessages ?? (() => false),
		compact: seed.compact ?? (() => undefined),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
