import { connect, type Socket } from "node:net";

import { encodeLine, LineDecoder, parseBrokerMessage, type BrokerMessage, type ClientMessage } from "./protocol.js";

export interface BridgeClientOptions {
	socketPath: string;
	onMessage: (message: BrokerMessage) => void;
	/** Called when no broker answers; may start one in this process. */
	tryBecomeBroker: () => Promise<boolean>;
	connectSocket?: (path: string) => Socket;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	random?: () => number;
}

const MAX_QUEUED = 32;

/**
 * Session-side connection to the broker. Registrations are replayed on every
 * reconnect, so a broker takeover keeps all sessions routed; other messages
 * queue (bounded) while disconnected.
 */
export class TelegramBridgeClient {
	private socket: Socket | undefined;
	private connected = false;
	private connecting = false;
	private disposed = false;
	private retryTimer: unknown;
	private failures = 0;
	private readonly registrations = new Map<string, Extract<ClientMessage, { t: "register" }>>();
	private readonly queue: ClientMessage[] = [];
	private readonly setTimer: NonNullable<BridgeClientOptions["setTimer"]>;
	private readonly clearTimer: NonNullable<BridgeClientOptions["clearTimer"]>;

	constructor(private readonly options: BridgeClientOptions) {
		this.setTimer = options.setTimer ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; });
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	get isConnected(): boolean {
		return this.connected;
	}

	start(): void {
		if (!this.disposed && !this.socket && !this.connecting && this.retryTimer === undefined) void this.connect();
	}

	send(message: ClientMessage): void {
		if (this.disposed) return;
		if (message.t === "register") {
			this.registrations.set(message.sessionId, message);
		} else if (message.t === "rename") {
			const registration = this.registrations.get(message.sessionId);
			if (registration) this.registrations.set(message.sessionId, { ...registration, title: message.title });
		} else if (message.t === "unregister") {
			this.registrations.delete(message.sessionId);
		}
		if (this.connected && this.socket) {
			this.write(message);
			return;
		}
		// Registrations replay from the map; only queue the rest.
		if (message.t !== "register" && message.t !== "rename") {
			this.queue.push(message);
			if (this.queue.length > MAX_QUEUED) this.queue.shift();
		}
		this.start();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.retryTimer !== undefined) this.clearTimer(this.retryTimer);
		this.retryTimer = undefined;
		// Best-effort goodbye so topics close promptly; the socket close covers the rest.
		if (this.connected && this.socket) {
			for (const sessionId of this.registrations.keys()) this.write({ t: "unregister", sessionId });
		}
		this.registrations.clear();
		this.queue.length = 0;
		this.socket?.end();
		this.socket?.destroy();
		this.socket = undefined;
		this.connected = false;
	}

	private write(message: ClientMessage): void {
		try {
			this.socket?.write(encodeLine(message));
		} catch { /* The close handler reconnects. */ }
	}

	private async connect(): Promise<void> {
		if (this.disposed) return;
		this.connecting = true;
		try {
			let socket = await this.open();
			if (!socket && !this.disposed && await this.options.tryBecomeBroker().catch(() => false)) socket = await this.open();
			if (this.disposed) { socket?.destroy(); return; }
			if (!socket) { this.scheduleRetry(); return; }
			this.attach(socket);
		} finally {
			this.connecting = false;
		}
	}

	private open(): Promise<Socket | undefined> {
		return new Promise((resolve) => {
			let socket: Socket;
			try {
				socket = (this.options.connectSocket ?? connect)(this.options.socketPath);
			} catch {
				resolve(undefined);
				return;
			}
			const fail = () => { socket.destroy(); resolve(undefined); };
			socket.once("error", fail);
			socket.once("connect", () => {
				socket.off("error", fail);
				resolve(socket);
			});
		});
	}

	private attach(socket: Socket): void {
		this.socket = socket;
		this.connected = true;
		this.failures = 0;
		socket.unref();
		socket.setEncoding("utf8");
		const decoder = new LineDecoder((value) => {
			const message = parseBrokerMessage(value);
			if (!message || !this.registrations.has(message.sessionId)) return;
			try { this.options.onMessage(message); } catch { /* Handler owns its own errors. */ }
		});
		socket.on("data", (chunk: string) => decoder.push(chunk));
		socket.on("error", () => {});
		socket.on("close", () => {
			if (this.socket !== socket) return;
			this.socket = undefined;
			this.connected = false;
			// Broker gone (its process exited): reconnect or take over quickly.
			this.scheduleRetry(150);
		});
		for (const registration of this.registrations.values()) this.write(registration);
		for (const message of this.queue.splice(0)) this.write(message);
	}

	private scheduleRetry(fixedMs?: number): void {
		if (this.disposed || this.retryTimer !== undefined) return;
		this.failures++;
		const jitter = (this.options.random ?? Math.random)() * 250;
		const delay = fixedMs ?? Math.min(10_000, 500 * 2 ** Math.min(this.failures - 1, 5));
		this.retryTimer = this.setTimer(() => {
			this.retryTimer = undefined;
			void this.connect();
		}, delay + jitter);
	}
}
