import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync, chmodSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { TelegramBridgeBroker, type BrokerConnection, type BrokerState } from "./broker.js";
import type { TelegramBridgeConfig } from "./config.js";
import { loadNotifications } from "./notifications.js";
import { encodeLine, LineDecoder, parseClientMessage, type BrokerMessage } from "./protocol.js";
import { createTelegramCall, TelegramApiError, TelegramSendQueue, type TelegramCall, type TelegramUpdate } from "./telegram-api.js";

type Report = (level: "info" | "warn" | "error", event: string, fields?: Record<string, string | number | boolean>) => void;

export interface BrokerHostOptions {
	call?: TelegramCall;
	report?: Report;
	pid?: number;
	isProcessAlive?: (pid: number) => boolean;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	pollTimeoutSeconds?: number;
	closeGraceMs?: number;
	/** Disable polling (tests drive updates directly). */
	poll?: boolean;
	/** Re-read credentials; undefined keeps the current ones (missing/invalid file). */
	reloadConfig?: () => TelegramBridgeConfig | undefined;
}

/** Unix socket on macOS/Linux; per-user named pipe on Windows. */
export function brokerSocketPath(stateDir: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pix-telegram-bridge-${Buffer.from(stateDir).toString("hex").slice(-32)}`;
	}
	return join(stateDir, "broker.sock");
}

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) { resolve(); return; }
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

function loadState(file: string): BrokerState {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<BrokerState>;
		const topics: BrokerState["topics"] = {};
		if (raw.topics && typeof raw.topics === "object") {
			for (const [sessionId, record] of Object.entries(raw.topics)) {
				if (record && Number.isSafeInteger(record.threadId) && typeof record.name === "string") {
					topics[sessionId] = { threadId: record.threadId, name: record.name, closed: record.closed === true,
						updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
						...(record.notifications ? { notifications: loadNotifications(record.notifications) } : {}) };
				}
			}
		}
		return { offset: Number.isSafeInteger(raw.offset) ? raw.offset! : 0,
			...(Number.isSafeInteger(raw.chatId) ? { chatId: raw.chatId! } : {}), topics };
	} catch {
		return { offset: 0, topics: {} };
	}
}

/** One per process at most; a /reload creates a new extension instance in the same process. */
const ACTIVE_HOST = Symbol.for("pix.telegram-bridge.broker-host");
type HostGlobal = typeof globalThis & { [ACTIVE_HOST]?: TelegramBridgeBrokerHost };

/**
 * Leader-elected broker: the first pi session process that takes the lock
 * file owns Telegram polling and the local socket. When it exits, a remaining
 * session takes over (its client reconnect calls tryAcquire again).
 */
export class TelegramBridgeBrokerHost {
	readonly broker: TelegramBridgeBroker;
	private readonly server: Server;
	private readonly sockets = new Set<Socket>();
	private readonly queue: TelegramSendQueue;
	private readonly abort = new AbortController();
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private polling: Promise<void> | undefined;

	private constructor(
		private config: TelegramBridgeConfig,
		private readonly paths: { lock: string; socket: string; state: string },
		private readonly state: BrokerState,
		private readonly call: TelegramCall,
		private readonly options: BrokerHostOptions,
		private readonly pid: number,
	) {
		this.queue = new TelegramSendQueue(call);
		this.broker = new TelegramBridgeBroker({
			...(config.chatId !== undefined ? { chatId: config.chatId } : {}),
			allowedUserIds: config.allowedUserIds,
			send: (method, params) => this.queue.run(method, params),
			state,
			saveState: () => this.scheduleSave(),
			...(options.report ? { report: options.report } : {}),
			...(options.closeGraceMs !== undefined ? { closeGraceMs: options.closeGraceMs } : {}),
		});
		this.server = createServer((socket) => this.accept(socket));
	}

	static current(): TelegramBridgeBrokerHost | undefined {
		return (globalThis as HostGlobal)[ACTIVE_HOST];
	}

	/** Returns a running host, or undefined when another live process already owns the lock. */
	static async tryAcquire(config: TelegramBridgeConfig, options: BrokerHostOptions = {}): Promise<TelegramBridgeBrokerHost | undefined> {
		const existing = TelegramBridgeBrokerHost.current();
		if (existing && !existing.disposed) return existing;
		const pid = options.pid ?? process.pid;
		const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
		mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
		const paths = {
			lock: join(config.stateDir, "broker.lock"),
			socket: brokerSocketPath(config.stateDir),
			state: join(config.stateDir, "state.json"),
		};
		if (!acquireLock(paths.lock, pid, isAlive)) return undefined;
		const host = new TelegramBridgeBrokerHost(config, paths, loadState(paths.state),
			options.call ?? createTelegramCall(config.botToken), options, pid);
		try {
			await host.listen();
		} catch (error) {
			host.releaseLock();
			throw error;
		}
		(globalThis as HostGlobal)[ACTIVE_HOST] = host;
		if (options.poll !== false) host.polling = host.pollLoop();
		options.report?.("info", "broker-started");
		return host;
	}

	get socketPath(): string {
		return this.paths.socket;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const global = globalThis as HostGlobal;
		if (global[ACTIVE_HOST] === this) delete global[ACTIVE_HOST];
		this.abort.abort();
		this.broker.dispose();
		this.queue.dispose();
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		if (process.platform !== "win32") {
			try { unlinkSync(this.paths.socket); } catch { /* Already gone. */ }
		}
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		this.saveNow();
		this.releaseLock();
		await this.polling?.catch(() => {});
	}

	private async listen(): Promise<void> {
		if (process.platform !== "win32") {
			// We own the lock, so any socket file left behind is stale.
			try { unlinkSync(this.paths.socket); } catch { /* Not present. */ }
		}
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.paths.socket, () => {
				this.server.off("error", reject);
				resolve();
			});
		});
		this.server.on("error", () => this.options.report?.("warn", "broker-socket-error"));
		// The broker rides along in a session process; it must never keep it alive.
		this.server.unref();
		if (process.platform !== "win32") {
			try { chmodSync(this.paths.socket, 0o600); } catch { /* Best effort. */ }
		}
	}

	private accept(socket: Socket): void {
		if (this.disposed) { socket.destroy(); return; }
		this.sockets.add(socket);
		socket.unref();
		socket.setEncoding("utf8");
		const connection: BrokerConnection = {
			send: (message: BrokerMessage) => {
				if (socket.destroyed) throw new Error("connection closed");
				socket.write(encodeLine(message));
			},
		};
		const decoder = new LineDecoder((value) => {
			const message = parseClientMessage(value);
			if (message) this.broker.handleClientMessage(connection, message);
		});
		socket.on("data", (chunk: string) => decoder.push(chunk));
		socket.on("error", () => {});
		socket.on("close", () => {
			this.sockets.delete(socket);
			this.broker.detach(connection);
		});
	}

	private async pollLoop(): Promise<void> {
		const signal = this.abort.signal;
		const sleep = this.options.sleep ?? abortableSleep;
		let failures = 0;
		try {
			await this.call("deleteWebhook", { drop_pending_updates: false }, signal);
		} catch { /* getUpdates reports any real problem. */ }
		while (!signal.aborted) {
			if (this.refreshConfig() === "restarting") return;
			try {
				const updates = await this.call<TelegramUpdate[]>("getUpdates", {
					offset: this.state.offset,
					timeout: this.options.pollTimeoutSeconds ?? 30,
					allowed_updates: ["message", "callback_query"],
				}, signal);
				failures = 0;
				for (const update of updates) {
					if (update.update_id >= this.state.offset) this.state.offset = update.update_id + 1;
					this.broker.handleUpdate(update);
				}
				if (updates.length > 0) this.scheduleSave();
			} catch (error) {
				if (signal.aborted) return;
				failures++;
				const code = error instanceof TelegramApiError ? error.code : 0;
				// 409: another bot instance (or a webhook) is polling; 401: bad token.
				const delay = code === 401 ? 300_000 : code === 409 ? 30_000 : Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
				if (failures === 1 || code === 401 || code === 409) {
					this.options.report?.(code === 401 ? "error" : "warn", code === 409 ? "poll-conflict" : "poll-failed",
						{ errorType: error instanceof TelegramApiError ? "NetworkError" : "OtherError", attempts: failures });
				}
				await sleep(delay, signal);
			}
		}
	}

	/**
	 * Pick up edits of telegram-bridge.jsonc (checked before every poll, i.e.
	 * at most every poll timeout). A new token or state directory restarts the
	 * broker: clients reconnect and the next owner starts with fresh config.
	 */
	refreshConfig(): "unchanged" | "updated" | "restarting" {
		if (this.disposed) return "restarting";
		const next = this.options.reloadConfig?.();
		if (!next) return "unchanged";
		if (next.botToken !== this.config.botToken || next.stateDir !== this.config.stateDir) {
			this.options.report?.("info", "broker-restart-config");
			void this.dispose();
			return "restarting";
		}
		const sameUsers = next.allowedUserIds.length === this.config.allowedUserIds.length
			&& next.allowedUserIds.every((id, index) => id === this.config.allowedUserIds[index]);
		if (next.chatId === this.config.chatId && sameUsers) return "unchanged";
		this.config = next;
		this.broker.reconfigure({ ...(next.chatId !== undefined ? { chatId: next.chatId } : {}), allowedUserIds: next.allowedUserIds });
		return "updated";
	}

	private scheduleSave(): void {
		if (this.disposed || this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.saveNow();
		}, 500);
		this.saveTimer.unref?.();
	}

	private saveNow(): void {
		const temp = `${this.paths.state}.${this.pid}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
			renameSync(temp, this.paths.state);
		} catch {
			this.options.report?.("warn", "state-save-failed");
			try { unlinkSync(temp); } catch { /* Nothing to clean. */ }
		}
	}

	private releaseLock(): void {
		try {
			if (Number(readFileSync(this.paths.lock, "utf8").trim()) === this.pid) unlinkSync(this.paths.lock);
		} catch { /* Already released or taken over. */ }
	}
}

/** Exclusive-create lock holding the owner pid; a dead owner's lock is reclaimed. */
export function acquireLock(file: string, pid: number, isAlive: (pid: number) => boolean): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(file, "wx", 0o600);
			try { writeSync(fd, String(pid)); } finally { closeSync(fd); }
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let owner: number;
		try {
			const raw = readFileSync(file, "utf8").trim();
			// Another process created the lock but has not written its pid yet.
			if (!raw && Date.now() - statSync(file).mtimeMs < 5000) return false;
			owner = Number(raw);
		} catch {
			continue; // Released between our create and read: retry.
		}
		// Our own pid without a live host in this process means a previous
		// extension instance was torn down (reload) without releasing it.
		const stale = !Number.isSafeInteger(owner) || owner <= 0
			|| (owner === pid ? !TelegramBridgeBrokerHost.current() : !isAlive(owner));
		if (!stale) return false;
		try { unlinkSync(file); } catch { /* Someone else reclaimed it first. */ }
	}
	return false;
}
