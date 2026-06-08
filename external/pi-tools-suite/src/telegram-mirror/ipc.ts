/**
 * IPC for telegram-mirror: Unix socket with JSON-lines framing, leader
 * election via bind-or-connect, and request-response correlation.
 *
 * Why IPC: Telegram allows exactly one concurrent getUpdates per bot token.
 * With N pi instances sharing one bot, exactly one process must poll and
 * route. The first pi to start becomes leader; later pis connect as
 * followers and forward their events to the leader. If the leader dies,
 * followers detect (heartbeat timeout / socket close) and the next to
 * acquire wins.
 *
 * Wire protocol (one JSON object per line, UTF-8):
 *
 *   Handshake
 *     follower → leader: { type: "register", info: InstanceInfo }
 *     leader → follower: { type: "registered", leader: InstanceInfo, activeId: string|null }
 *
 *   Heartbeat (symmetric)
 *     any → any:        { type: "ping", t: <ms> }
 *     any → any:        { type: "pong", t: <ms> }
 *
 *   Events (follower → leader)
 *     { type: "event", from: "<id>", event: <RendererEvent JSON> }
 *
 *   Commands (leader → follower) — request/ack
 *     { type: "command", reqId, to, command: "sendUserMessage"|"abort"|"compact", args? }
 *     { type: "command_ack", reqId, ok: true|false, error? }
 *
 *   Queries (leader → follower) — request/reply
 *     { type: "query", reqId, to, query: "status" }
 *     { type: "query_reply", reqId, ok: true|false, result?, error? }
 *
 * Heartbeat: each side pings every 8s; closes after 20s without any traffic.
 *
 * Leader election:
 *   1. Try `net.createServer().listen(socketPath)`.
 *      - Success → leader.
 *      - EADDRINUSE → existing socket, try connect.
 *   2. Try `net.createConnection(socketPath)` with 1.5s timeout.
 *      - Success → follower.
 *      - Any failure → stale socket.
 *   3. Unlink and retry listen once.
 *   4. Give up.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export interface InstanceInfo {
	/** Stable unique id, e.g. `${pid}@${cwd}`. */
	id: string;
	/** OS pid. */
	pid: number;
	/** Absolute working dir of this pi process. */
	cwd: string;
	/** Human-friendly label, e.g. basename of cwd + short pid suffix. */
	label: string;
	/** ms-since-epoch when this instance started. */
	started: number;
}

export type IpcMessage =
	| { type: "register"; info: InstanceInfo }
	| { type: "registered"; leader: InstanceInfo; activeId: string | null }
	| { type: "ping"; t: number }
	| { type: "pong"; t: number }
	| { type: "event"; from: string; event: unknown }
	| { type: "command"; reqId: string; to: string; command: string; args?: unknown }
	| { type: "command_ack"; reqId: string; ok: boolean; error?: string }
	| { type: "query"; reqId: string; to: string; query: string }
	| { type: "query_reply"; reqId: string; ok: boolean; result?: unknown; error?: string }
	| { type: "stand_down" };

export const DEFAULT_SOCKET_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"extensions",
	"pi-tools-suite",
	".run",
	"telegram-mirror.sock",
);

const PING_INTERVAL_MS = 8_000;
const IDLE_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 1_500;
const REQUEST_TIMEOUT_MS = 5_000;

interface PendingRequest {
	resolve: (msg: IpcMessage) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/**
 * JSON-lines framing over a single TCP/unix socket.
 *
 * Sends one IpcMessage per `\n`-terminated JSON line. Tracks pending
 * request-response pairs by reqId for command/query correlation. Maintains
 * bidirectional heartbeat; closes the socket on prolonged silence.
 */
export class IpcSocket {
	public readonly role: "leader" | "follower";
	public readonly info: InstanceInfo | undefined;

	public onMessage?: (msg: IpcMessage) => void;
	public onClose?: () => void;
	public onError?: (error: Error) => void;

	private readonly socket: net.Socket;
	private buffer = "";
	private closed = false;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private pingTimer: NodeJS.Timeout | undefined;
	private watchdogTimer: NodeJS.Timeout | undefined;

	constructor(socket: net.Socket, role: "leader" | "follower", info?: InstanceInfo) {
		this.socket = socket;
		this.role = role;
		this.info = info;
		socket.setEncoding("utf8");
		socket.setNoDelay(true);
		socket.on("data", (chunk: string | Buffer) => {
			if (this.closed) return;
			this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			this.consumeBuffer();
		});
		socket.on("error", (error) => {
			if (this.closed) return;
			this.onError?.(error);
		});
		socket.on("close", () => this.handleClose());

		this.resetWatchdog();
		this.pingTimer = setInterval(() => {
			if (!this.closed) this.send({ type: "ping", t: Date.now() });
		}, PING_INTERVAL_MS);
	}

	send(msg: IpcMessage): void {
		if (this.closed) return;
		this.socket.write(`${JSON.stringify(msg)}\n`);
	}

	/**
	 * Send a request and await its ack/reply (matched on reqId).
	 * Resolves on the matching IpcMessage; rejects on timeout or socket close.
	 */
	request(msg: IpcMessage, timeoutMs = REQUEST_TIMEOUT_MS): Promise<IpcMessage> {
		const reqId = (msg as { reqId?: string }).reqId;
		if (!reqId) return Promise.reject(new Error("IpcSocket.request: message must have reqId"));
		return new Promise<IpcMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(reqId);
				reject(new Error(`IPC request ${reqId} timed out`));
			}, timeoutMs);
			this.pendingRequests.set(reqId, { resolve, reject, timer });
			this.send(msg);
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.clearTimers();
		try {
			this.socket.destroy();
		} catch {
			// ignore
		}
	}

	get isClosed(): boolean {
		return this.closed;
	}

	private consumeBuffer(): void {
		let newlineIdx = this.buffer.indexOf("\n");
		while (newlineIdx >= 0) {
			const line = this.buffer.slice(0, newlineIdx).trim();
			this.buffer = this.buffer.slice(newlineIdx + 1);
			newlineIdx = this.buffer.indexOf("\n");
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!parsed || typeof parsed !== "object") continue;
			this.handleIncoming(parsed as IpcMessage);
		}
	}

	private handleIncoming(msg: IpcMessage): void {
		this.resetWatchdog();

		// Auto-reply to ping so the other side's watchdog resets.
		if (msg.type === "ping") {
			this.send({ type: "pong", t: msg.t });
			// Don't forward pings to upper layer.
			return;
		}
		if (msg.type === "pong") {
			// Don't forward pongs either.
			return;
		}

		// Resolve pending request if this is an ack/reply.
		const reqId = (msg as { reqId?: string }).reqId;
		if (reqId && (msg.type === "command_ack" || msg.type === "query_reply")) {
			const pending = this.pendingRequests.get(reqId);
			if (pending) {
				this.pendingRequests.delete(reqId);
				clearTimeout(pending.timer);
				pending.resolve(msg);
				return;
			}
		}

		this.onMessage?.(msg);
	}

	private resetWatchdog(): void {
		if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
		this.watchdogTimer = setTimeout(() => {
			// Idle too long — force close so the other side triggers
			// reconnect/election.
			this.close();
		}, IDLE_TIMEOUT_MS);
	}

	private handleClose(): void {
		if (this.closed && !this.pingTimer) return; // already cleaned up via close()
		this.closed = true;
		this.clearTimers();
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("socket closed"));
		}
		this.pendingRequests.clear();
		this.onClose?.();
	}

	private clearTimers(): void {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = undefined;
		}
		if (this.watchdogTimer) {
			clearTimeout(this.watchdogTimer);
			this.watchdogTimer = undefined;
		}
	}
}

/**
 * Leader-side accept loop. Tracks every connected follower socket.
 * The multiplexer attaches `onMessage`/`onClose` callbacks after the
 * follower registers and we know its InstanceInfo.
 */
export class IpcServer {
	public readonly socketPath: string;
	public onFollowerConnect?: (socket: IpcSocket) => void;
	public onClose?: () => void;

	private readonly server: net.Server;
	private readonly sockets = new Set<IpcSocket>();
	private closed = false;

	constructor(server: net.Server, socketPath: string) {
		this.server = server;
		this.socketPath = socketPath;
		server.on("connection", (raw: net.Socket) => {
			const ipcSocket = new IpcSocket(raw, "leader");
			this.sockets.add(ipcSocket);
			ipcSocket.onClose = () => {
				this.sockets.delete(ipcSocket);
			};
			this.onFollowerConnect?.(ipcSocket);
		});
		server.on("error", () => {
			// server socket errors are unexpected; we'll let the upper layer
			// observe via the close event.
		});
		server.on("close", () => {
			this.closed = true;
			this.onClose?.();
		});
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** Send a message to every connected follower. Best-effort, skips closed sockets. */
	broadcast(msg: IpcMessage): void {
		for (const s of [...this.sockets]) {
			if (!s.isClosed) s.send(msg);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const s of [...this.sockets]) s.close();
		this.sockets.clear();
		await new Promise<void>((resolve) => {
			this.server.close(() => resolve());
		});
		try {
			fs.unlinkSync(this.socketPath);
		} catch {
			// best-effort
		}
	}
}

type LeadershipOutcome =
	| { role: "leader"; server: IpcServer }
	| { role: "follower"; socket: IpcSocket };

/**
 * Try to bind as leader; if the socket is already in use, try to connect as
 * follower; if the existing socket is stale (no listener), unlink and retry
 * the bind. Throws if none of these succeed.
 */
export async function tryAcquireLeadership(socketPath: string): Promise<LeadershipOutcome> {
	ensureRunDir(socketPath);

	const server = await tryListen(socketPath);
	if (server) return { role: "leader", server: new IpcServer(server, socketPath) };

	const sock = await tryConnect(socketPath);
	if (sock) return { role: "follower", socket: new IpcSocket(sock, "follower") };

	// Stale socket — clean up and retry once.
	try {
		fs.unlinkSync(socketPath);
	} catch {
		// ignore
	}
	const serverRetry = await tryListen(socketPath);
	if (serverRetry) return { role: "leader", server: new IpcServer(serverRetry, socketPath) };

	throw new Error(`tryAcquireLeadership: could not bind or connect at ${socketPath}`);
}

function tryListen(socketPath: string): Promise<net.Server | null> {
	return new Promise((resolve) => {
		const server = net.createServer();
		const onError = (err: NodeJS.ErrnoException) => {
			server.removeListener("listening", onListening);
			// EADDRINUSE → existing live listener or stale socket; resolve null
			// so caller can try connect or unlink+retry.
			if (err.code === "EADDRINUSE" || err.code === "EACCES") resolve(null);
			else resolve(null);
		};
		const onListening = () => {
			server.removeListener("error", onError);
			resolve(server);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(socketPath);
	});
}

function tryConnect(socketPath: string): Promise<net.Socket | null> {
	return new Promise((resolve) => {
		let settled = false;
		const sock = net.createConnection(socketPath);
		const finish = (result: net.Socket | null) => {
			if (settled) {
				if (!result) sock.destroy();
				return;
			}
			settled = true;
			clearTimeout(timer);
			sock.removeListener("connect", onConnect);
			sock.removeListener("error", onError);
			resolve(result);
		};
		const timer = setTimeout(() => finish(null), CONNECT_TIMEOUT_MS);
		const onConnect = () => finish(sock);
		const onError = () => finish(null);
		sock.once("connect", onConnect);
		sock.once("error", onError);
	});
}

function ensureRunDir(socketPath: string): void {
	const dir = path.dirname(socketPath);
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "EEXIST") throw error;
	}
}

/** Convenience: generate a stable id for this pi process. */
export function buildInstanceId(): { id: string; info: InstanceInfo } {
	const cwd = process.cwd();
	const pid = process.pid;
	const id = `${pid}@${cwd}`;
	const cwdBase = path.basename(cwd) || cwd;
	const label = `${cwdBase} (#${pid})`;
	return {
		id,
		info: { id, pid, cwd, label, started: Date.now() },
	};
}

/** Generate a unique request id for command/query correlation. */
export function generateReqId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
