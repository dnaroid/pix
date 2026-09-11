import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerRemoteQuestionHandler } from "../question/remote.js";
import type { NormalizedQuestion } from "../question/types.js";
import { resolveTelegramConnectorConfig } from "./config.js";
import { getTelegramConnectorCoordinator, type TelegramSessionEndpoint } from "./coordinator.js";

const INTERNAL_NEW_SESSION_COMMAND = "telegram-new-session";
const SESSION_ABORTED_EVENT = "pix:session-aborted";

type AssistantMessageUpdateLike = {
	type?: unknown;
	reason?: unknown;
	error?: { errorMessage?: unknown };
};

export default function telegramConnector(pi: ExtensionAPI): void {
	const config = resolveTelegramConnectorConfig();
	const coordinator = getTelegramConnectorCoordinator();
	let currentCtx: ExtensionContext | undefined;
	let attachedSessionId: string | undefined;
	let attachedEndpoint: TelegramSessionEndpoint | undefined;
	let unregisterRemoteQuestion: (() => void) | undefined;
	let lastAssistantText: string | undefined;
	let lastFailureReason: string | undefined;
	let userAborted = false;

	function attach(ctx: ExtensionContext): void {
		currentCtx = ctx;
		const sessionId = ctx.sessionManager.getSessionId();
		if (attachedSessionId === sessionId) return;
		if (attachedSessionId) coordinator.detachSession(attachedSessionId, attachedEndpoint);
		unregisterRemoteQuestion?.();
		attachedSessionId = sessionId;

		const endpoint: TelegramSessionEndpoint = {
			sessionId,
			cwd: ctx.cwd,
			getTitle: () => safeSessionTitle(pi, currentCtx, sessionId),
			isIdle: () => safeIsIdle(currentCtx),
			sendUserMessage: (text) => {
				const options = safeIsIdle(currentCtx) ? undefined : { deliverAs: "followUp" as const };
				pi.sendUserMessage(text, options);
			},
			dispatchNewSession: (requestId) => {
				const options = {
					...(safeIsIdle(currentCtx) ? {} : { deliverAs: "followUp" as const }),
					expandPromptTemplates: true,
				};
				pi.sendUserMessage(`/${INTERNAL_NEW_SESSION_COMMAND} ${requestId}`, options);
			},
		};

		attachedEndpoint = endpoint;
		coordinator.attachSession(endpoint, config);
		unregisterRemoteQuestion = registerRemoteQuestionHandler(sessionId, (questions, signal) =>
			coordinator.askQuestions(sessionId, questions as NormalizedQuestion[], signal));
	}

	function detach(): void {
		unregisterRemoteQuestion?.();
		unregisterRemoteQuestion = undefined;
		if (attachedSessionId) coordinator.detachSession(attachedSessionId, attachedEndpoint);
		attachedSessionId = undefined;
		attachedEndpoint = undefined;
		currentCtx = undefined;
	}

	pi.registerCommand("tg", {
		description: "Show Telegram connector status",
		handler: async (_args, ctx) => {
			attach(ctx);
			if (!config.enabled || !config.botToken || !config.chatId) {
				ctx.ui.notify("Telegram connector is not configured. Set telegramConnector.botToken/chatId or PIX_TELEGRAM_* env vars.", "warning");
				return;
			}
			ctx.ui.notify("Telegram connector is active for this Pix process.", "info");
			void coordinator.sendStatus().catch(() => {});
		},
	});

	// Internal command dispatched through sendUserMessage(expandPromptTemplates=true).
	// This intentionally obtains a fresh ExtensionCommandContext at execution time,
	// instead of keeping command contexts alive across async Telegram callbacks.
	pi.registerCommand(INTERNAL_NEW_SESSION_COMMAND, {
		description: "Internal Telegram connector session handoff",
		handler: async (args, ctx) => {
			const sourceSessionId = ctx.sessionManager.getSessionId();
			const requestId = args.trim();
			const task = coordinator.consumeNewSessionRequest(requestId, sourceSessionId);
			if (!task) return;
			try {
				await ctx.waitForIdle();
				const result = await ctx.newSession({
					withSession: async (nextCtx) => {
						const nextSessionId = nextCtx.sessionManager.getSessionId();
						// Start both operations from the fresh replacement context, but do not
						// make the agent turn wait for Telegram delivery (or vice versa).
						// The Bot API call is started first so the normal case shows the new-
						// session card before that session eventually reports completion.
						void coordinator.announceNewSession(nextSessionId).catch(() => {});
						void nextCtx.sendUserMessage(task, { expandPromptTemplates: false }).catch(() => {
							void coordinator.sendNotice("Новая сессия создана, но задачу запустить не удалось.").catch(() => {});
						});
					},
				});
				if (result.cancelled) {
					void coordinator.sendNotice("Новая сессия не была создана.").catch(() => {});
				}
			} catch {
				void coordinator.sendNotice("Не удалось создать новую сессию.").catch(() => {});
			} finally {
				coordinator.finishNewSessionRequest(sourceSessionId);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		attach(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		attach(ctx);
		lastAssistantText = undefined;
		lastFailureReason = undefined;
		userAborted = false;
	});

	pi.on("message_end", async (event, ctx) => {
		attach(ctx);
		const text = assistantVisibleText(event.message);
		if (text) lastAssistantText = text;
	});

	pi.on("message_update", async (event, ctx) => {
		attach(ctx);
		const update = event.assistantMessageEvent as AssistantMessageUpdateLike;
		if (update.type === "error" && update.reason === "aborted") {
			userAborted = true;
			lastFailureReason = undefined;
			return;
		}
		if (update.type === "error") {
			const reason = typeof update.error?.errorMessage === "string" ? update.error.errorMessage.trim() : "";
			if (reason) lastFailureReason = reason;
			return;
		}
		if (typeof update.type === "string") lastFailureReason = undefined;
	});

	pi.events.on(SESSION_ABORTED_EVENT, (data: unknown) => {
		if (isRecord(data) && data.aborted === true) {
			userAborted = true;
			lastFailureReason = undefined;
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		attach(ctx);
		if (userAborted || !attachedSessionId) return;
		const sessionId = attachedSessionId;
		const summary = lastFailureReason ?? lastAssistantText;
		void coordinator.notifyCompletion(sessionId, lastFailureReason ? "error" : "complete", summary).catch(() => {
			// Telegram is an optional notification channel and must never delay or fail the run.
		});
	});

	pi.on("session_shutdown", async () => {
		detach();
	});
}

export function assistantVisibleText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	const content = message.content;
	if (typeof content === "string") return normalizedText(content);
	if (!Array.isArray(content)) return undefined;
	const text = content.flatMap((part) => {
		if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return [];
		return [part.text];
	}).join("\n");
	return normalizedText(text);
}

function safeSessionTitle(pi: ExtensionAPI, ctx: ExtensionContext | undefined, sessionId: string): string {
	try {
		const title = pi.getSessionName()?.trim() || ctx?.sessionManager.getSessionName?.()?.trim();
		return title || sessionId.slice(0, 8);
	} catch {
		return sessionId.slice(0, 8);
	}
}

function safeIsIdle(ctx: ExtensionContext | undefined): boolean {
	try {
		return ctx?.isIdle() ?? false;
	} catch {
		return false;
	}
}

function normalizedText(text: string): string | undefined {
	const normalized = text.trim();
	return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
