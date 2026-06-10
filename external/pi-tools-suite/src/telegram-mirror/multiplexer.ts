/**
 * Multiplexer: leader-side orchestrator for the telegram mirror.
 *
 * Owns:
 *   - The follower registry (instanceId → { socket, info, lastSeen }).
 *   - The `activeId` (which instance's events go to Telegram and which
 *     instance receives commands from Telegram).
 *   - Routing of incoming pi events (own + forwarded by followers) to the
 *     Telegram renderer — only if the emitter matches `activeId`.
 *   - Routing of incoming Telegram text/commands to the active instance
 *     (executed locally if the leader is active, or forwarded over IPC to
 *     the follower otherwise).
 *
 * Lifecycle:
 *   - Constructed once when this pi wins leadership.
 *   - `init()` is called after the bot connects (so we can default active
 *     to self).
 *   - `attachFollower()` is wired into IpcServer.onFollowerConnect.
 *   - `close()` is called on session_shutdown or leadership loss.
 *
 * Failure modes handled:
 *   - Follower socket closes → drop from registry, fall back to leader if
 *     it was active.
 *   - Active follower doesn't reply within ~10s → command/query fails with
 *     a user-readable error to Telegram.
 *   - Leader crash → followers detect via IpcSocket watchdog and try to
 *     acquire leadership themselves (handled in index.ts, not here).
 */

import type { TelegramBot, TelegramReplyMarkup, TelegramUpdate } from "./bot.js";
import type { RendererEvent, RendererInstance } from "./renderer.js";
import type { IpcServer, IpcSocket, InstanceInfo } from "./ipc.js";
import { generateReqId } from "./ipc.js";

/** Locally-executable operations on the leader's own pi session. */
export interface LocalDispatch {
	sendUserMessage(text: string): void;
	currentDialog(): string | undefined;
	abort(): void;
	compact(): void;
	status(): { idle: boolean; hasPending: boolean } | undefined;
}

export interface MultiplexerDeps {
	selfId: string;
	selfInfo: InstanceInfo;
	bot: TelegramBot;
	renderer: {
		push(event: RendererEvent): void;
		reset(): void;
		showTranscript?(instance: RendererInstance | undefined, transcript: string): Promise<void>;
		sentIds?: readonly number[];
	};
	server: IpcServer;
	dispatch: LocalDispatch;
	/** Cluster-wide teardown: broadcast stand_down to followers then stop polling. */
	standDown: () => Promise<void>;
	log?: (message: string) => void;
}

interface FollowerEntry {
	socket: IpcSocket;
	info: InstanceInfo;
}

interface InstanceEntry {
	info: InstanceInfo;
	isLeader: boolean;
}

interface InstanceStatus {
	idle: boolean;
	hasPending: boolean;
}

const COMMAND_TIMEOUT_MS = 10_000;

export class Multiplexer {
	private readonly selfId: string;
	private readonly selfInfo: InstanceInfo;
	private readonly bot: TelegramBot;
	private readonly renderer: MultiplexerDeps["renderer"];
	private readonly server: IpcServer;
	private readonly dispatch: LocalDispatch;
	private readonly standDown: () => Promise<void>;
	private readonly log: (message: string) => void;

	private readonly followers = new Map<string, FollowerEntry>();
	private activeId: string | null = null;
	private readonly lastStatus = new Map<string, InstanceStatus>();

	constructor(deps: MultiplexerDeps) {
		this.selfId = deps.selfId;
		this.selfInfo = deps.selfInfo;
		this.bot = deps.bot;
		this.renderer = deps.renderer;
		this.server = deps.server;
		this.dispatch = deps.dispatch;
		this.standDown = deps.standDown;
		this.log = deps.log ?? (() => undefined);

		this.server.onFollowerConnect = (socket) => this.attachFollower(socket);
	}

	init(): void {
		// Default active to self (the leader). If a follower was active in a
		// previous life of the cluster, that state is lost — the user must
		// /use again. Acceptable for MVP.
		if (this.activeId === null) this.activeId = this.selfId;
	}

	getActiveId(): string | null {
		return this.activeId;
	}

	/** Snapshot of known instances, leader first. */
	listInstances(): InstanceEntry[] {
		return [
			{ info: this.selfInfo, isLeader: true },
			...[...this.followers.values()].map((entry) => ({ info: entry.info, isLeader: false })),
		];
	}

	/** Local pi events flow in here. */
	pushLocalEvent(event: RendererEvent): void {
		this.handleInstanceEvent(this.selfId, event);
	}

	async showActiveDialog(): Promise<void> {
		if (!this.activeId) return;
		await this.showDialogFor(this.activeId);
	}

	// ─── Telegram → pix dispatch ──────────────────────────────────────────

	async handleTgText(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;

		if (trimmed.startsWith("/")) {
			const messageId = updateMessageIdFromText();
			const [head, ...rest] = trimmed.split(/\s+/);
			const arg = rest.join(" ").trim();
			const command = normalizeBotCommand(head);
			switch (command) {
				case "/start":
				case "/help":
					await this.reply(HELP_TEXT, mainMenuMarkup());
					return;
				case "/menu":
					await this.reply("Choose a project/session to follow:", this.instancesMarkup());
					return;
				case "/list":
					await this.replyList();
					return;
				case "/use":
					await this.handleUse(arg);
					return;
				case "/abort":
				case "/stop":
					await this.routeCommandToActive("abort", undefined, "abort");
					return;
				case "/compact":
					await this.routeCommandToActive("compact", undefined, "compact");
					return;
				case "/status":
					await this.handleStatus();
					return;
				case "/clear":
				case "/clear_history":
				case "/clean":
					await this.clearTelegramHistory(messageId ? [messageId] : []);
					return;
				case "/say":
					if (!arg) {
						await this.reply("Usage: /say <message>");
						return;
					}
					await this.routeCommandToActive("sendUserMessage", { text: arg }, "/say");
					return;
				case "/new":
					await this.reply(
						"⚠️ /new from Telegram is not supported. Run /new inside pi.\n\n" +
							"You can still send free text below; it will be forwarded to the active instance.",
					);
					return;
				case "/disconnect":
					await this.reply("👋 Disconnecting telegram-mirror cluster. Run /reload in any pi to resume.");
					try {
						await this.standDown();
					} catch (error) {
						this.log(`standDown failed: ${errorMessage(error)}`);
					}
					return;
				default:
					// Unknown command → forward verbatim to the active instance.
					break;
			}
		}
		await this.routeCommandToActive("sendUserMessage", { text: trimmed }, "message");
	}

	async handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
		const callback = update.callback_query;
		if (callback) {
			await this.handleCallback(callback.id, callback.data ?? "");
			return;
		}
		const text = update.message?.text;
		if (typeof text === "string") await this.handleTgTextWithMessage(text, update.message?.message_id);
	}

	async handleTgTextWithMessage(text: string, messageId: number | undefined): Promise<void> {
		const previous = currentTelegramMessageId;
		currentTelegramMessageId = messageId;
		try {
			await this.handleTgText(text);
		} finally {
			currentTelegramMessageId = previous;
		}
	}

	// ─── Followers ───────────────────────────────────────────────────────

	private attachFollower(socket: IpcSocket): void {
			socket.onMessage = (msg) => {
			if (msg.type === "register") {
				this.registerFollower(socket, msg.info);
				return;
			}
			if (msg.type === "instance_update") {
				this.updateFollowerInfo(socket, msg.info);
				return;
			}
			if (msg.type === "event") {
				this.handleFollowerEvent(msg.from, msg.event as RendererEvent);
				return;
			}
			// pings/pongs/acks/replies are handled inside IpcSocket before
			// reaching here.
		};
		socket.onClose = () => {
			const entry = this.findFollowerBySocket(socket);
			if (!entry) return;
			this.followers.delete(entry.info.id);
			this.log(`follower disconnected: ${entry.info.label}`);
			if (this.activeId === entry.info.id) {
				this.activeId = this.selfId;
				void this.reply(`⚠️ Active instance ${entry.info.label} disconnected; fell back to leader (${this.selfInfo.label}).`);
			}
		};
		socket.onError = (error) => {
			this.log(`follower socket error: ${error.message}`);
		};
	}

	private registerFollower(socket: IpcSocket, info: InstanceInfo): void {
		const prev = this.followers.get(info.id);
		if (prev) {
			// Duplicate id (rare: pid reuse on same cwd). Replace the old conn.
			prev.socket.close();
		}
		this.followers.set(info.id, { socket, info });
		this.log(`follower registered: ${info.label}`);
		socket.send({ type: "registered", leader: this.selfInfo, activeId: this.activeId });
		void this.reply(`➕ ${formatInstanceTitle(info)} connected.`, this.instancesMarkup());
	}

	private updateFollowerInfo(socket: IpcSocket, info: InstanceInfo): void {
		const existing = this.followers.get(info.id);
		if (existing) {
			existing.info = info;
			return;
		}
		this.followers.set(info.id, { socket, info });
	}

	updateSelfInfo(info: InstanceInfo): void {
		this.selfInfo.cwd = info.cwd;
		this.selfInfo.label = info.label;
		this.selfInfo.sessionId = info.sessionId;
		this.selfInfo.sessionFile = info.sessionFile;
		this.selfInfo.sessionName = info.sessionName;
	}

	private findFollowerBySocket(socket: IpcSocket): FollowerEntry | undefined {
		for (const entry of this.followers.values()) {
			if (entry.socket === socket) return entry;
		}
		return undefined;
	}

	private handleFollowerEvent(fromId: string, event: RendererEvent): void {
		if (!this.followers.has(fromId)) return; // unknown/unregistered
		this.handleInstanceEvent(fromId, event);
	}

	private handleInstanceEvent(fromId: string, event: RendererEvent): void {
		const entry = this.getInstance(fromId);
		if (!entry) return;
		if (event.kind === "turn_start") {
			this.recordStatus(fromId, { idle: false, hasPending: false }, entry.info);
			if (this.activeId === fromId) this.renderer.push(withInstance(event, entry.info));
			return;
		}
		if (event.kind === "turn_end") {
			this.recordStatus(fromId, { idle: true, hasPending: false }, entry.info);
			if (this.activeId === fromId) {
				this.renderer.push(event);
			}
			return;
		}
		if (this.activeId === fromId) this.renderer.push(event);
	}

	private recordStatus(instanceId: string, next: InstanceStatus, info: InstanceInfo): void {
		const prev = this.lastStatus.get(instanceId);
		this.lastStatus.set(instanceId, next);
		if (prev && prev.idle === next.idle) return;
		const icon = next.idle ? "🟢" : "🟡";
		const text = `${icon} ${formatInstanceTitle(info)} is ${formatStatus(next)}.`;
		void this.reply(text, this.instancesMarkup(), { silent: instanceId !== this.activeId });
	}

	// ─── Routing helpers ─────────────────────────────────────────────────

	private async routeCommandToActive(
		command: "sendUserMessage" | "abort" | "compact",
		args: unknown,
		label: string,
	): Promise<void> {
		if (!this.activeId) {
			await this.reply("⚠️ No active instance. Run /list and /use N first.");
			return;
		}

		if (this.activeId === this.selfId) {
			try {
				switch (command) {
					case "sendUserMessage":
						this.dispatch.sendUserMessage((args as { text: string })?.text ?? "");
						break;
					case "abort":
						this.dispatch.abort();
						break;
					case "compact":
						this.dispatch.compact();
						break;
				}
			} catch (error) {
				await this.reply(`❌ ${label} failed: ${errorMessage(error)}`);
				return;
			}
			if (command !== "sendUserMessage") await this.reply(`✅ ${label} requested`);
			return;
		}

		const follower = this.followers.get(this.activeId);
		if (!follower) {
			this.activeId = this.selfId;
			await this.reply(`⚠️ Active instance disappeared; fell back to leader. Run /list to confirm.`);
			return;
		}
		try {
			const reqId = generateReqId();
			const ack = await follower.socket.request(
				{ type: "command", reqId, to: this.activeId, command, args },
				COMMAND_TIMEOUT_MS,
			);
			if (ack.type !== "command_ack" || !ack.ok) {
				await this.reply(`❌ ${label} on ${follower.info.label}: ${ack.type === "command_ack" ? ack.error ?? "unknown error" : "unexpected reply"}`);
				return;
			}
			if (command !== "sendUserMessage") await this.reply(`✅ ${label} on ${follower.info.label}`);
		} catch (error) {
			await this.reply(`❌ ${label} on ${follower.info.label} failed: ${errorMessage(error)}`);
		}
	}

	private async handleStatus(): Promise<void> {
		if (!this.activeId) {
			await this.reply("⚠️ No active instance. Run /list and /use N first.");
			return;
		}
		if (this.activeId === this.selfId) {
			const status = this.dispatch.status();
			if (!status) return await this.reply("⚠️ Status unavailable: no active session yet.");
			await this.reply(`🟢 ${this.selfInfo.label}: ${formatStatus(status)}`);
			return;
		}
		const follower = this.followers.get(this.activeId);
		if (!follower) {
			this.activeId = this.selfId;
			await this.reply(`⚠️ Active instance disappeared; fell back to leader.`);
			return;
		}
		try {
			const reqId = generateReqId();
			const reply = await follower.socket.request(
				{ type: "query", reqId, to: this.activeId, query: "status" },
				COMMAND_TIMEOUT_MS,
			);
			if (reply.type !== "query_reply" || !reply.ok) {
				await this.reply(`❌ status on ${follower.info.label}: ${reply.type === "query_reply" ? reply.error ?? "unknown error" : "unexpected reply"}`);
				return;
			}
			const result = (reply.result ?? {}) as { idle?: boolean; hasPending?: boolean };
			await this.reply(`🟢 ${follower.info.label}: ${formatStatus({ idle: !!result.idle, hasPending: !!result.hasPending })}`);
		} catch (error) {
			await this.reply(`❌ status on ${follower.info.label} failed: ${errorMessage(error)}`);
		}
	}

	private async handleUse(arg: string): Promise<void> {
		const instances = this.listInstances();
		if (!arg) {
			await this.reply("Usage: /use <number or id prefix>. Run /list to see options.");
			return;
		}
		const target = resolveUseTarget(arg, instances);
		if (!target) {
			await this.reply(`⚠️ No instance matches "${arg}". Run /list.`);
			return;
		}
		this.activeId = target.info.id;
		this.renderer.reset();
		await this.reply(`✅ Following: ${formatInstanceTitle(target.info)}${target.isLeader ? " (leader)" : ""}`, this.instancesMarkup());
		await this.showDialogFor(target.info.id);
	}

	private async showDialogFor(instanceId: string): Promise<void> {
		const entry = this.getInstance(instanceId);
		if (!entry) return;
		let text: string | undefined;
		if (instanceId === this.selfId) {
			text = this.dispatch.currentDialog();
		} else {
			const follower = this.followers.get(instanceId);
			if (!follower) return;
			try {
				const reqId = generateReqId();
				const reply = await follower.socket.request(
					{ type: "query", reqId, to: instanceId, query: "dialog" },
					COMMAND_TIMEOUT_MS,
				);
				if (reply.type === "query_reply" && reply.ok && isRecord(reply.result)) {
					text = typeof reply.result.text === "string" ? reply.result.text : undefined;
				}
			} catch (error) {
				this.log(`dialog query failed for ${entry.info.label}: ${errorMessage(error)}`);
				return;
			}
		}
		if (!text?.trim()) return;
		if (this.renderer.showTranscript) {
			await this.renderer.showTranscript(instanceToRenderer(entry.info), text);
			return;
		}
		this.renderer.reset();
		this.renderer.push({ kind: "turn_start", instance: instanceToRenderer(entry.info) });
		this.renderer.push({ kind: "assistant_text", delta: text });
	}

	private async replyList(): Promise<void> {
		const instances = this.listInstances();
		if (instances.length === 0) {
			await this.reply("No instances registered yet.");
			return;
		}
		const lines = instances.map((entry, idx) => {
			const marker = entry.info.id === this.activeId ? " [following]" : "";
			const role = entry.isLeader ? " (leader)" : "";
			const status = this.lastStatus.get(entry.info.id);
			const statusText = status ? ` — ${formatStatus(status)}` : "";
			return `${idx + 1}. ${formatInstanceTitle(entry.info)}${role}${marker}${statusText}`;
		});
		lines.push("");
		lines.push("Tap a button below, or use /use N.");
		await this.reply(lines.join("\n"), this.instancesMarkup());
	}

	private async handleCallback(callbackId: string, data: string): Promise<void> {
		try {
			await this.bot.answerCallbackQuery(callbackId);
		} catch (error) {
			this.log(`answerCallbackQuery failed: ${errorMessage(error)}`);
		}

		if (data === "tg:list") {
			await this.replyList();
			return;
		}
		if (data === "tg:status") {
			await this.handleStatus();
			return;
		}
		if (data === "tg:help") {
			await this.reply(HELP_TEXT, mainMenuMarkup());
			return;
		}
		if (data.startsWith("tg:use:")) {
			await this.handleUse(data.slice("tg:use:".length));
			return;
		}
	}

	private instancesMarkup(): TelegramReplyMarkup {
		const rows = this.listInstances().map((entry, idx) => {
			const prefix = entry.info.id === this.activeId ? "✅ " : "";
			return [{ text: `${prefix}${idx + 1}. ${buttonLabel(entry.info)}`, callback_data: `tg:use:${idx + 1}` }];
		});
		rows.push([
			{ text: "🔄 List", callback_data: "tg:list" },
			{ text: "📊 Status", callback_data: "tg:status" },
		]);
		return { inline_keyboard: rows };
	}

	private async clearTelegramHistory(extraMessageIds: readonly number[] = []): Promise<void> {
		const result = await this.bot.deleteKnownMessages([...(this.renderer.sentIds ?? []), ...extraMessageIds]);
		this.renderer.reset();
		this.log(`telegram history clear requested: attempted=${result.attempted} deleted=${result.deleted}`);
	}

	private getInstance(id: string): InstanceEntry | undefined {
		if (id === this.selfId) return { info: this.selfInfo, isLeader: true };
		const follower = this.followers.get(id);
		return follower ? { info: follower.info, isLeader: false } : undefined;
	}

	private async reply(text: string, replyMarkup?: TelegramReplyMarkup, options: { silent?: boolean } = {}): Promise<void> {
		try {
			await this.bot.sendMessage(text, { replyMarkup, silent: options.silent });
		} catch (error) {
			this.log(`reply failed: ${errorMessage(error)}`);
		}
	}

	close(): void {
		this.renderer.reset();
	}
}

function formatStatus(status: { idle: boolean; hasPending: boolean }): string {
	if (status.idle) return "idle";
	return status.hasPending ? "streaming (queued messages waiting)" : "streaming";
}

function formatInstanceTitle(info: InstanceInfo): string {
	return info.sessionName ? `${info.label} · ${info.sessionName}` : info.label;
}

function buttonLabel(info: InstanceInfo): string {
	return info.sessionName ? `${info.label} · ${info.sessionName}` : info.label;
}

function withInstance(event: Extract<RendererEvent, { kind: "turn_start" }>, info: InstanceInfo): RendererEvent {
	return {
		...event,
		instance: instanceToRenderer(info),
	};
}

function instanceToRenderer(info: InstanceInfo): RendererInstance {
	return {
		label: info.label,
		cwd: info.cwd,
		...(info.sessionId ? { sessionId: info.sessionId } : {}),
		...(info.sessionName ? { sessionName: info.sessionName } : {}),
	};
}

function normalizeBotCommand(head: string): string {
	const withoutMention = head.split("@", 1)[0] ?? head;
	return withoutMention.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

let currentTelegramMessageId: number | undefined;

function updateMessageIdFromText(): number | undefined {
	return currentTelegramMessageId;
}

function mainMenuMarkup(): TelegramReplyMarkup {
	return {
			inline_keyboard: [
				[{ text: "🧭 Choose project/session", callback_data: "tg:list" }],
				[{ text: "📊 Active status", callback_data: "tg:status" }],
			],
		};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resolveUseTarget(arg: string, instances: { info: InstanceInfo; isLeader: boolean }[]): { info: InstanceInfo; isLeader: boolean } | undefined {
	const trimmed = arg.trim();
	// By 1-based index
	const asNumber = Number(trimmed);
	if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= instances.length) {
		return instances[asNumber - 1];
	}
	// By id/label substring (case-insensitive)
	const lower = trimmed.toLowerCase();
	const exact = instances.find((entry) => entry.info.id.toLowerCase() === lower);
	if (exact) return exact;
	const partial = instances.find(
		(entry) => entry.info.id.toLowerCase().includes(lower) || entry.info.label.toLowerCase().includes(lower),
	);
	return partial;
}

const HELP_TEXT = [
	"<b>pix Telegram mirror</b>",
	"",
	"Free text → forwarded to the <i>followed</i> pi session.",
	"",
	"<b>Multi-instance commands</b>",
	"/menu — show Telegram buttons",
	"/list — show all known pi instances",
	"/use N — follow by 1-based index from /list",
	"/use &lt;id&gt; — switch by id/label substring",
	"/disconnect — stop the bot cluster-wide (resume with /reload in pi)",
	"",
	"<b>Per-instance commands</b>",
	"/abort /stop — cancel current turn on active",
	"/compact — trigger compaction on active",
	"/status — show idle/streaming state of active",
	"/clear — best-effort delete known bot messages from this chat",
	"/say &lt;msg&gt; — explicit send (escape /-prefixed text)",
	"/new — not supported; run /new inside pi",
	"/help — this message",
].join("\n");
