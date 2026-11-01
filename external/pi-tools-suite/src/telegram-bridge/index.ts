import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { SecretRedactor } from "../credential-firewall/redact.js";
import { publishRpcSessionState } from "../lib/rpc-session-state.js";
import { diagnosticErrorType, suiteDiagnostics } from "../lib/suite-diagnostics.js";
import { brokerSocketPath, TelegramBridgeBrokerHost } from "./broker-host.js";
import { TelegramBridgeClient, type BridgeClientOptions } from "./client.js";
import { loadTelegramBridgeConfig, type TelegramBridgeConfig } from "./config.js";
import type { BrokerMessage, NotifyKind } from "./protocol.js";

/** Structured-state channel ACP turns into a live user row in Desktop. */
export const TELEGRAM_INBOUND_CHANNEL = "telegram-bridge:inbound";
const SUBAGENT_META_ENV = "PI_SUBAGENT_META";

type Env = Record<string, string | undefined>;

/**
 * Only real user sessions get a topic: Pix Desktop sessions (ACP RPC) and
 * interactive TUI sessions. Sub-agents, print/json runs and helper RPC
 * processes are excluded.
 */
export function isBridgeEligible(ctx: Pick<ExtensionContext, "mode" | "hasUI">, env: Env = process.env): boolean {
	if (env[SUBAGENT_META_ENV]) return false;
	if (ctx.mode === "tui") return ctx.hasUI;
	return ctx.mode === "rpc" && env.PIX_ACP_SESSION_STATE_BRIDGE === "1";
}

export function assistantText(message: unknown): { text: string; error?: string } | undefined {
	const m = message as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
	if (m?.role !== "assistant") return undefined;
	const text = Array.isArray(m.content)
		? m.content.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
			&& typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join("\n\n").trim()
		: "";
	const error = m.stopReason === "error" ? (typeof m.errorMessage === "string" && m.errorMessage.trim() ? m.errorMessage.trim() : "The model request failed.") : undefined;
	return { text, ...(error ? { error } : {}) };
}

function report(level: "info" | "warn" | "error", event: string, fields: Record<string, string | number | boolean> = {}, cwd?: string): void {
	suiteDiagnostics.report(level, "telegram", event, cwd ?? null, fields);
}

type BridgeClient = Pick<TelegramBridgeClient, "send" | "dispose" | "isConnected">;

interface Runtime {
	config: TelegramBridgeConfig;
	client: BridgeClient;
}

export interface TelegramBridgeExtensionDeps {
	loadConfig?: typeof loadTelegramBridgeConfig;
	createClient?: (options: BridgeClientOptions) => BridgeClient;
	env?: Env;
}

export function createTelegramBridgeExtension(deps: TelegramBridgeExtensionDeps = {}): (pi: ExtensionAPI) => void {
	return (pi) => registerTelegramBridge(pi, deps);
}

export default createTelegramBridgeExtension();

function registerTelegramBridge(pi: ExtensionAPI, deps: TelegramBridgeExtensionDeps): void {
	const env = deps.env ?? process.env;
	let runtime: Runtime | undefined;
	let configProblem: string | undefined;
	let ctx: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let lastAnswer: string | undefined;
	let lastError: string | undefined;
	const redactor = new SecretRedactor();

	function notify(kind: NotifyKind, text: string): void {
		if (!runtime || !sessionId) return;
		runtime.client.send({ t: "notify", sessionId, kind, text: redactor.redactString(text).value });
	}

	function handleBrokerMessage(message: BrokerMessage): void {
		const current = ctx;
		const ack = (ok: boolean, error?: string) => runtime?.client.send({
			t: "ack", sessionId: message.sessionId, requestId: message.requestId, ok, ...(error ? { error } : {}),
		});
		if (!current || message.sessionId !== sessionId) {
			ack(false, "The session is not ready yet.");
			return;
		}
		if (message.t === "stop") {
			if (current.isIdle()) { ack(false, "Nothing is running."); return; }
			current.abort();
			ack(true);
			return;
		}
		// Shown immediately in Desktop as a user row; TUI renders the message itself.
		publishRpcSessionState(current, TELEGRAM_INBOUND_CHANNEL, { text: message.text });
		try {
			if (current.isIdle()) pi.sendUserMessage(message.text);
			else pi.sendUserMessage(message.text, { deliverAs: "followUp" });
			ack(true);
		} catch (error) {
			// Idle state can flip between the check and the send.
			try {
				pi.sendUserMessage(message.text, { deliverAs: "followUp" });
				ack(true);
			} catch {
				report("warn", "prompt-delivery-failed", { errorType: diagnosticErrorType(error) }, current.cwd);
				ack(false, "Pix could not queue the message.");
			}
		}
	}

	function ensureRuntime(cwd: string): Runtime | undefined {
		if (runtime) return runtime;
		const loaded = (deps.loadConfig ?? loadTelegramBridgeConfig)({ env });
		if (!loaded.ok) {
			const problem = `${loaded.detail} (${loaded.path})`;
			// An enabled module without credentials is a setup problem worth one record.
			if (configProblem !== problem) report("warn", "config-unavailable", {}, cwd);
			configProblem = problem;
			return undefined;
		}
		configProblem = loaded.config.chatId === undefined ? "chatId is not set: send /id in your forum group to get it" : undefined;
		const config = loaded.config;
		const client = (deps.createClient ?? ((options) => new TelegramBridgeClient(options)))({
			socketPath: brokerSocketPath(config.stateDir),
			onMessage: handleBrokerMessage,
			tryBecomeBroker: async () => {
				try {
					return Boolean(await TelegramBridgeBrokerHost.tryAcquire(config, {
						report: (level, event, fields) => report(level, event, fields, cwd),
					}));
				} catch (error) {
					report("warn", "broker-start-failed", { errorType: diagnosticErrorType(error) }, cwd);
					return false;
				}
			},
		});
		runtime = { config, client };
		return runtime;
	}

	async function teardown(): Promise<void> {
		const current = runtime;
		runtime = undefined;
		current?.client.dispose();
		// Hand the broker role to another session process; its client reconnects and takes over.
		await TelegramBridgeBrokerHost.current()?.dispose();
	}

	pi.on("session_start", (_event, context) => {
		ctx = context;
		lastAnswer = undefined;
		lastError = undefined;
		if (!isBridgeEligible(context, env)) return;
		const active = ensureRuntime(context.cwd);
		const id = context.sessionManager.getSessionId();
		if (!active || !id) return;
		sessionId = id;
		const title = pi.getSessionName();
		active.client.send({
			t: "register",
			sessionId: id,
			project: basename(context.cwd) || context.cwd,
			cwd: context.cwd,
			...(title ? { title } : {}),
		});
	});

	pi.on("session_info_changed", (event) => {
		if (runtime && sessionId) runtime.client.send({ t: "rename", sessionId, title: event.name ?? "" });
	});

	pi.on("agent_start", () => {
		lastAnswer = undefined;
		lastError = undefined;
	});

	pi.on("message_end", (event) => {
		const result = assistantText(event.message);
		if (!result) return;
		if (result.text) lastAnswer = result.text;
		lastError = result.error;
	});

	pi.on("agent_settled", (event) => {
		const answer = lastAnswer;
		const error = lastError;
		lastAnswer = undefined;
		lastError = undefined;
		if (event.aborted) notify("aborted", answer ? `Stopped.\n\n${answer}` : "Stopped.");
		else if (error) notify("error", error);
		else if (answer) notify("final", answer);
	});

	pi.on("ui_prompt_start", (event) => {
		notify("waiting", `Waiting for your answer in Pix${event.title ? `: ${event.title}` : "."}`);
	});

	pi.on("session_shutdown", async (event) => {
		if (runtime && sessionId) runtime.client.send({ t: "unregister", sessionId });
		sessionId = undefined;
		ctx = undefined;
		if (event.reason === "quit" || event.reason === "reload") await teardown();
	});

	pi.registerCommand("telegram", {
		description: "Show Telegram bridge status for this session.",
		handler: async (_args, context) => {
			const host = TelegramBridgeBrokerHost.current();
			const lines = runtime
				? [
					`Telegram bridge: ${runtime.client.isConnected ? "connected" : "connecting"}${host ? " (this process is the broker)" : ""}.`,
					...(configProblem ? [`Setup: ${configProblem}.`] : []),
				]
				: [`Telegram bridge is inactive${configProblem ? `: ${configProblem}` : isBridgeEligible(context, env) ? "." : " for this kind of session."}`];
			context.ui.notify(lines.join("\n"), runtime && !configProblem ? "info" : "warning");
		},
	});
}
