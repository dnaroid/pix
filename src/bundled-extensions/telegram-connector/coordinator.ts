import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import type { NormalizedQuestion, QuestionSelection } from "../question/types.js";
import { TelegramBotClient, type TelegramIncomingMessage } from "./bot.js";
import type { TelegramConnectorConfig } from "./config.js";

const COMPLETION_ROUTE_LIMIT = 200;
const NEW_SESSION_REQUEST_TTL_MS = 10 * 60_000;
const STOP_GRACE_MS = 750;

export type TelegramCompletionKind = "complete" | "error";

export type TelegramSessionEndpoint = {
	sessionId: string;
	cwd: string;
	getTitle(): string;
	isIdle(): boolean;
	sendUserMessage(text: string): void;
	dispatchNewSession(requestId: string): void;
};

type PendingQuestionReply = {
	sessionId: string;
	resolve: (text: string | null) => void;
};

type NewSessionRequest = {
	sourceSessionId: string;
	task: string;
	expiresAt: number;
};

type BotLike = Pick<TelegramBotClient, "start" | "stop" | "sendMessage">;
type BotFactory = (botToken: string, chatId: string) => BotLike;

export class TelegramConnectorCoordinator {
	private readonly sessions = new Map<string, TelegramSessionEndpoint>();
	private readonly completionRoutes = new Map<number, string>();
	private readonly pendingQuestions = new Map<number, PendingQuestionReply>();
	private readonly newSessionRequests = new Map<string, NewSessionRequest>();
	private readonly newSessionSources = new Map<string, number>();
	private bot: BotLike | undefined;
	private botKey: string | undefined;
	private focusSessionId: string | undefined;
	private stopTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly createBot: BotFactory = (botToken, chatId) => new TelegramBotClient(botToken, chatId),
		private readonly reportError: (message: string) => void = (message) => process.stderr.write(`[telegram-connector] ${message}\n`),
	) {}

	attachSession(endpoint: TelegramSessionEndpoint, config: TelegramConnectorConfig): void {
		this.sessions.set(endpoint.sessionId, endpoint);
		this.clearStopTimer();
		if (!config.enabled || !config.botToken || !config.chatId) return;
		this.ensureBot(config.botToken, config.chatId);
	}

	detachSession(sessionId: string, endpoint?: TelegramSessionEndpoint): void {
		if (endpoint && this.sessions.get(sessionId) !== endpoint) return;
		this.sessions.delete(sessionId);
		if (this.focusSessionId === sessionId) this.focusSessionId = undefined;
		for (const [messageId, pending] of this.pendingQuestions) {
			if (pending.sessionId !== sessionId) continue;
			this.pendingQuestions.delete(messageId);
			pending.resolve(null);
		}
		if (this.sessions.size === 0) this.scheduleStop();
	}

	async notifyCompletion(sessionId: string, kind: TelegramCompletionKind, summary?: string): Promise<void> {
		const endpoint = this.sessions.get(sessionId);
		const bot = this.bot;
		if (!endpoint || !bot) return;
		const messageId = await bot.sendMessage(formatCompletionMessage(endpoint, kind, summary));
		if (this.bot !== bot || this.sessions.get(sessionId) !== endpoint) return;
		this.focusSessionId = sessionId;
		this.rememberCompletionRoute(messageId, sessionId);
	}

	async askQuestions(
		sessionId: string,
		questions: NormalizedQuestion[],
		signal?: AbortSignal,
	): Promise<QuestionSelection[] | null | undefined> {
		const endpoint = this.sessions.get(sessionId);
		const bot = this.bot;
		if (!endpoint || !bot) return undefined;
		if (signal?.aborted) return null;
		this.focusSessionId = sessionId;
		const selections: QuestionSelection[] = [];
		for (let index = 0; index < questions.length; index++) {
			const question = questions[index]!;
			const messageId = await bot.sendMessage(formatQuestionMessage(endpoint, question, index, questions.length), signal);
			if (signal?.aborted || this.bot !== bot || this.sessions.get(sessionId) !== endpoint) return null;
			let answer = await this.waitForQuestionReply(messageId, sessionId, signal);
			while (true) {
				if (answer === null || isCancelCommand(answer)) return null;
				const parsed = parseQuestionAnswer(question, answer);
				if (parsed) {
					selections.push(parsed);
					break;
				}
				// Re-arm the route before awaiting Telegram feedback. Otherwise a quick
				// corrected reply can arrive after the invalid reply removed the old
				// pending entry but before the feedback send completes.
				const nextAnswer = this.waitForQuestionReply(messageId, sessionId, signal);
				try {
					await bot.sendMessage("Не понял выбор. Ответьте на исходный вопрос номером варианта, несколькими номерами через запятую или своим текстом.", signal);
				} catch (error) {
					this.cancelPendingQuestion(messageId, sessionId);
					throw error;
				}
				if (signal?.aborted || this.bot !== bot || this.sessions.get(sessionId) !== endpoint) {
					this.cancelPendingQuestion(messageId, sessionId);
					return null;
				}
				answer = await nextAnswer;
			}
		}
		return selections;
	}

	createNewSessionRequest(sourceSessionId: string, task: string): string | undefined {
		const endpoint = this.sessions.get(sourceSessionId);
		const normalizedTask = task.trim();
		if (!endpoint || !normalizedTask) return undefined;
		this.pruneExpiredNewSessionRequests();
		if ((this.newSessionSources.get(sourceSessionId) ?? 0) > Date.now()) return undefined;
		const requestId = randomUUID();
		const expiresAt = Date.now() + NEW_SESSION_REQUEST_TTL_MS;
		this.newSessionRequests.set(requestId, {
			sourceSessionId,
			task: normalizedTask,
			expiresAt,
		});
		this.newSessionSources.set(sourceSessionId, expiresAt);
		try {
			endpoint.dispatchNewSession(requestId);
			this.focusSessionId = sourceSessionId;
			return requestId;
		} catch (error) {
			this.newSessionRequests.delete(requestId);
			this.newSessionSources.delete(sourceSessionId);
			this.reportError(errorMessage(error));
			return undefined;
		}
	}

	consumeNewSessionRequest(requestId: string, sourceSessionId: string): string | undefined {
		this.pruneExpiredNewSessionRequests();
		const request = this.newSessionRequests.get(requestId);
		if (!request || request.sourceSessionId !== sourceSessionId) return undefined;
		this.newSessionRequests.delete(requestId);
		return request.task;
	}

	finishNewSessionRequest(sourceSessionId: string): void {
		this.newSessionSources.delete(sourceSessionId);
	}

	async announceNewSession(sessionId: string): Promise<void> {
		const endpoint = this.sessions.get(sessionId);
		const bot = this.bot;
		if (!endpoint || !bot) return;
		const messageId = await bot.sendMessage(`🆕 Новая сессия · ${sessionLabel(endpoint)}\nСессия создана. Задача запускается.`);
		if (this.bot !== bot || this.sessions.get(sessionId) !== endpoint) return;
		this.focusSessionId = sessionId;
		this.rememberCompletionRoute(messageId, sessionId);
	}

	async sendStatus(): Promise<void> {
		if (!this.bot) return;
		const endpoint = this.focusSessionId ? this.sessions.get(this.focusSessionId) : undefined;
		if (!endpoint) {
			await this.bot.sendMessage("Нет активной Telegram-сессии. Дождитесь уведомления от Pix или запустите задачу локально.");
			return;
		}
		await this.bot.sendMessage(`${endpoint.isIdle() ? "🟢 idle" : "🟡 busy"} · ${sessionLabel(endpoint)}`);
	}

	async sendHelp(): Promise<void> {
		if (!this.bot) return;
		await this.bot.sendMessage([
			"Telegram connector",
			"",
			"↩️ Ответьте на уведомление — продолжить в той же сессии.",
			"🆕 /new <задача> — новая сессия (можно ответом на конкретное уведомление).",
			"📍 /status — текущая сессия.",
			"❌ /cancel — отменить ожидающий Telegram-вопрос.",
		].join("\n"));
	}

	async sendNotice(text: string): Promise<void> {
		await this.bot?.sendMessage(text);
	}

	async handleIncoming(message: TelegramIncomingMessage): Promise<void> {
		const explicitQuestion = message.replyToMessageId === undefined ? undefined : this.pendingQuestions.get(message.replyToMessageId);
		if (explicitQuestion) {
			this.resolvePendingQuestion(message.replyToMessageId!, explicitQuestion, message.text);
			return;
		}

		const command = parseTelegramCommand(message.text);
		if (
			message.replyToMessageId === undefined
			&& this.pendingQuestions.size === 1
			&& (command.kind === "message" || isCancelCommand(message.text))
		) {
			const [messageId, pending] = this.pendingQuestions.entries().next().value as [number, PendingQuestionReply];
			this.resolvePendingQuestion(messageId, pending, message.text);
			return;
		}

		if (
			message.replyToMessageId === undefined
			&& this.pendingQuestions.size > 1
			&& (command.kind === "message" || isCancelCommand(message.text))
		) {
			await this.bot?.sendMessage("Есть несколько ожидающих вопросов. Ответьте reply на конкретное сообщение с вопросом.");
			return;
		}

		if (command.kind === "help") {
			await this.sendHelp();
			return;
		}
		if (command.kind === "status") {
			await this.sendStatus();
			return;
		}
		if (message.replyToMessageId === undefined && this.sessions.size > 1) {
			await this.bot?.sendMessage("Есть несколько живых сессий. Ответьте reply на уведомление нужной сессии, чтобы не отправить задачу не туда.");
			return;
		}

		const routedSessionId = message.replyToMessageId === undefined
			? this.focusSessionId
			: this.completionRoutes.get(message.replyToMessageId);
		const endpoint = routedSessionId ? this.sessions.get(routedSessionId) : undefined;
		if (!endpoint) {
			await this.bot?.sendMessage("Не могу определить живую сессию для этого сообщения. Ответьте на свежее уведомление от Pix.");
			return;
		}

		this.focusSessionId = endpoint.sessionId;
		if (command.kind === "new") {
			if (!command.task) {
				await this.bot?.sendMessage("Использование: /new <задача>");
				return;
			}
			if (this.hasPendingQuestionFor(endpoint.sessionId)) {
				await this.bot?.sendMessage("Эта сессия ждёт ответа на вопрос. Сначала ответьте на вопрос или отправьте /cancel reply на него.");
				return;
			}
			const requestId = this.createNewSessionRequest(endpoint.sessionId, command.task);
			await this.bot?.sendMessage(requestId ? "🆕 Создаю новую сессию и передаю задачу." : "Не удалось запустить новую сессию.");
			return;
		}

		try {
			endpoint.sendUserMessage(command.text);
			await this.bot?.sendMessage(`➡️ Отправлено · ${sessionLabel(endpoint)}`);
		} catch (error) {
			this.reportError(errorMessage(error));
			await this.bot?.sendMessage("Не удалось отправить сообщение: сессия уже заменена или недоступна.");
		}
	}

	stop(): void {
		this.clearStopTimer();
		this.bot?.stop();
		this.bot = undefined;
		this.botKey = undefined;
		for (const pending of this.pendingQuestions.values()) pending.resolve(null);
		this.pendingQuestions.clear();
		this.completionRoutes.clear();
		this.newSessionRequests.clear();
		this.newSessionSources.clear();
		this.focusSessionId = undefined;
	}

	private ensureBot(botToken: string, chatId: string): void {
		const key = `${botToken}\u0000${chatId}`;
		if (this.bot && this.botKey === key) return;
		this.stop();
		this.botKey = key;
		this.bot = this.createBot(botToken, chatId);
		this.bot.start(
			(message) => this.handleIncoming(message),
			(error) => this.reportError(error.message),
		);
	}

	private waitForQuestionReply(messageId: number, sessionId: string, signal?: AbortSignal): Promise<string | null> {
		return new Promise((resolve) => {
			let settled = false;
			const onAbort = () => settle(null);
			const settle = (text: string | null) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				if (this.pendingQuestions.get(messageId)?.resolve === settle) this.pendingQuestions.delete(messageId);
				resolve(text);
			};
			this.pendingQuestions.set(messageId, { sessionId, resolve: settle });
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	}

	private resolvePendingQuestion(messageId: number, pending: PendingQuestionReply, text: string): void {
		this.pendingQuestions.delete(messageId);
		this.focusSessionId = pending.sessionId;
		pending.resolve(text);
	}

	private cancelPendingQuestion(messageId: number, sessionId: string): void {
		const pending = this.pendingQuestions.get(messageId);
		if (!pending || pending.sessionId !== sessionId) return;
		this.pendingQuestions.delete(messageId);
		pending.resolve(null);
	}

	private rememberCompletionRoute(messageId: number, sessionId: string): void {
		this.completionRoutes.set(messageId, sessionId);
		while (this.completionRoutes.size > COMPLETION_ROUTE_LIMIT) {
			const oldest = this.completionRoutes.keys().next().value as number | undefined;
			if (oldest === undefined) break;
			this.completionRoutes.delete(oldest);
		}
	}

	private hasPendingQuestionFor(sessionId: string): boolean {
		return [...this.pendingQuestions.values()].some((pending) => pending.sessionId === sessionId);
	}

	private pruneExpiredNewSessionRequests(): void {
		const now = Date.now();
		for (const [requestId, request] of this.newSessionRequests) {
			if (request.expiresAt <= now) this.newSessionRequests.delete(requestId);
		}
		for (const [sessionId, expiresAt] of this.newSessionSources) {
			if (expiresAt <= now) this.newSessionSources.delete(sessionId);
		}
	}

	private scheduleStop(): void {
		this.clearStopTimer();
		this.stopTimer = setTimeout(() => {
			this.stopTimer = undefined;
			if (this.sessions.size === 0) this.stop();
		}, STOP_GRACE_MS);
		this.stopTimer.unref?.();
	}

	private clearStopTimer(): void {
		if (!this.stopTimer) return;
		clearTimeout(this.stopTimer);
		this.stopTimer = undefined;
	}
}

type ParsedTelegramCommand =
	| { kind: "new"; task: string }
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "message"; text: string };

export function parseTelegramCommand(text: string): ParsedTelegramCommand {
	const trimmed = text.trim();
	const commandMatch = /^\/(new|help|status)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(trimmed);
	if (!commandMatch) return { kind: "message", text: trimmed };
	const command = commandMatch[1]!.toLowerCase();
	if (command === "help") return { kind: "help" };
	if (command === "status") return { kind: "status" };
	return { kind: "new", task: commandMatch[2]?.trim() ?? "" };
}

export function parseQuestionAnswer(question: NormalizedQuestion, answer: string): QuestionSelection | undefined {
	const trimmed = answer.trim();
	if (!trimmed || isCancelCommand(trimmed)) return undefined;
	const numeric = trimmed.match(/^\d+(?:\s*[, ]\s*\d+)*$/)?.[0];
	if (!numeric) {
		if (!question.multiple) return { id: question.id, customText: trimmed };
		if ((question.minSelections ?? 1) > 1 || (question.maxSelections ?? question.choices.length + 1) < 1) return undefined;
		return { id: question.id, choiceValues: [], customText: trimmed };
	}
	const indexes = numeric.split(/\s*[, ]\s*/).filter(Boolean).map((value) => Number(value));
	if (indexes.some((index) => !Number.isInteger(index) || index < 1 || index > question.choices.length)) return undefined;
	const unique = [...new Set(indexes)];
	if (question.multiple) {
		if (unique.length < (question.minSelections ?? 1) || unique.length > (question.maxSelections ?? question.choices.length + 1)) return undefined;
		return { id: question.id, choiceValues: unique.map((index) => question.choices[index - 1]!.value) };
	}
	if (unique.length !== 1) return undefined;
	return { id: question.id, choiceValue: question.choices[unique[0]! - 1]!.value };
}

function formatCompletionMessage(endpoint: TelegramSessionEndpoint, kind: TelegramCompletionKind, summary?: string): string {
	const heading = kind === "error" ? "🔴 Ошибка" : "✅ Готово";
	const body = summary?.trim();
	return [
		`${heading} · ${sessionLabel(endpoint)}`,
		...(body ? ["", body.slice(0, 2500)] : []),
		"",
		"↩️ Ответьте на это сообщение — продолжить в этой сессии.",
		"🆕 /new <задача> — начать новую сессию.",
	].join("\n");
}

function formatQuestionMessage(
	endpoint: TelegramSessionEndpoint,
	question: NormalizedQuestion,
	index: number,
	total: number,
): string {
	const choices = question.choices.map((choice, choiceIndex) => {
		const description = choice.description ? ` — ${choice.description}` : "";
		return `${choiceIndex + 1}. ${choice.label}${description}`;
	});
	const multipleHint = question.multiple ? "Можно несколько номеров через запятую." : "Можно номер варианта или свой текст.";
	const lines = [`❓ Вопрос ${total > 1 ? `${index + 1}/${total} · ` : ""}${sessionLabel(endpoint)}`];
	if (question.label) lines.push(question.label);
	lines.push(question.prompt);
	if (choices.length > 0) lines.push("", ...choices);
	lines.push("", `${multipleHint} /cancel — отменить.`);
	return lines.join("\n");
}

function sessionLabel(endpoint: TelegramSessionEndpoint): string {
	const title = endpoint.getTitle().trim() || endpoint.sessionId.slice(0, 8);
	const project = basename(endpoint.cwd) || endpoint.cwd;
	return title === project ? title : `${title} · ${project}`;
}

function isCancelCommand(text: string): boolean {
	return /^\/cancel(?:@[A-Za-z0-9_]+)?$/i.test(text.trim());
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const COORDINATOR_KEY = Symbol.for("pix.telegram.connector.coordinator.v1");

export function getTelegramConnectorCoordinator(): TelegramConnectorCoordinator {
	const root = globalThis as typeof globalThis & { [COORDINATOR_KEY]?: TelegramConnectorCoordinator };
	root[COORDINATOR_KEY] ??= new TelegramConnectorCoordinator();
	return root[COORDINATOR_KEY];
}

export function resetTelegramConnectorCoordinatorForTests(): void {
	const root = globalThis as typeof globalThis & { [COORDINATOR_KEY]?: TelegramConnectorCoordinator };
	root[COORDINATOR_KEY]?.stop();
	delete root[COORDINATOR_KEY];
}
