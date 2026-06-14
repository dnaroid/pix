import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { loadSessionTitleConfig, type SessionTitleConfig } from "./config";

type SessionEntryLike = {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

type TextContentLike = {
	type?: string;
	text?: unknown;
};

type PendingGeneration = {
	sessionId: string;
	input: string;
	modelRefs: string[];
	modelIndex: number;
	attempts: number;
	replaceSessionName?: string;
	provisionalSessionName?: string;
};

type ForkTitleState = {
	sessionId: string;
	parentTitle: string | undefined;
	inheritedSessionName: string | undefined;
};

const DEFAULT_TERMINAL_TITLE = "pi";

const TITLE_SYSTEM_PROMPT = [
	"You name Pi coding-agent sessions from the user's first request.",
	"Return only one concise title, without quotes, markdown, emoji, or explanations.",
	"Use the same language as the task when possible.",
	"Keep it specific, 3-7 words, and under the requested character limit.",
].join("\n");

function parseModelRef(modelRef: string): { provider: string; modelId: string } | undefined {
	const trimmed = modelRef.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function messageContentText(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;

	const text = content
		.filter((block: TextContentLike): block is { type: string; text: string } => (
			block?.type === "text" && typeof block.text === "string"
		))
		.map((block) => block.text)
		.join("\n")
		.trim();

	return text || undefined;
}

export function firstUserMessageText(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch() as SessionEntryLike[]) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = messageContentText(entry.message.content);
		if (text) return text;
	}
	return undefined;
}

function hasExistingUserMessage(ctx: ExtensionContext): boolean {
	return firstUserMessageText(ctx) !== undefined;
}

export function fallbackSessionTitleFromInput(input: string, maxTitleChars: number): string | undefined {
	const normalized = input
		.replace(/[\t\r\n]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.replace(/^[`"'«»“”()[\]{}<>.,:;!?~@#$%^&*_+=\\/|\-]+/gu, "")
		.trim();

	if (!normalized) return undefined;

	const words = normalized.split(/\s+/u).filter(Boolean);
	if (words.length === 0) return undefined;

	const selected: string[] = [];
	for (const word of words) {
		const next = selected.length === 0 ? word : `${selected.join(" ")} ${word}`;
		if (selected.length > 0 && next.length > maxTitleChars) break;
		selected.push(word);
		if (selected.length >= 8) break;
	}

	const candidate = selected.join(" ");
	return sanitizeSessionTitle(candidate || normalized, maxTitleChars);
}

function truncateInput(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

function terminalSafeText(text: string): string {
	return text
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function buildTitlePrompt(input: string, maxTitleChars: number): string {
	return [
		`Generate a session title under ${maxTitleChars} characters for this session.`,
		"If a parent session title is provided, use it only as context and focus on the new request.",
		"Output only the title.",
		"",
		"<session_context>",
		input,
		"</session_context>",
	].join("\n");
}

export function buildForkTitleInput(parentTitle: string | undefined, forkPrompt: string): string {
	const prompt = forkPrompt.trim();
	const parent = parentTitle?.trim();
	if (!parent) return prompt;

	return [
		"Parent session title:",
		parent,
		"",
		"First prompt in this fork:",
		prompt,
	].join("\n");
}

function responseText(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

export function sanitizeSessionTitle(raw: string, maxTitleChars: number): string | undefined {
	let title = raw
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean) ?? "";

	title = title
		.replace(/^```(?:\w+)?\s*/u, "")
		.replace(/```$/u, "")
		.replace(/^(?:title|\u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435|\u0438\u043c\u044f \u0441\u0435\u0441\u0441\u0438\u0438)\s*[:—-]\s*/iu, "")
		.replace(/["'`«»“”]+/gu, "")
		.replace(/[\t\r\n]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.replace(/[.。!！?？,:;]+$/u, "")
		.trim();

	if (!title) return undefined;
	if (title.length > maxTitleChars) {
		title = title.slice(0, maxTitleChars).trimEnd().replace(/[\s,;:—-]+$/u, "");
	}
	return title || undefined;
}

export function sessionTitleModelRefs(config: SessionTitleConfig): string[] {
	return [config.model, ...config.fallbackModels]
		.map((modelRef) => modelRef.trim())
		.filter(Boolean)
		.filter((modelRef, index, refs) => refs.indexOf(modelRef) === index);
}

async function resolveTitleModel(ctx: ExtensionContext, modelRefValue: string, config: SessionTitleConfig): Promise<{
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
} | undefined> {
	const modelRef = parseModelRef(modelRefValue);
	if (!modelRef) {
		if (config.debug && ctx.hasUI) ctx.ui.notify(`Invalid session-title model: ${modelRefValue}`, "warning");
		return undefined;
	}

	const model = ctx.modelRegistry.find(modelRef.provider, modelRef.modelId);
	if (!model) {
		if (config.debug && ctx.hasUI) ctx.ui.notify(`Session-title model not found: ${modelRefValue}`, "warning");
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) {
		if (config.debug && ctx.hasUI) ctx.ui.notify(auth.error, "warning");
		return undefined;
	}

	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

async function generateSessionTitle(
	input: string,
	ctx: ExtensionContext,
	config: SessionTitleConfig,
	modelRef: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const resolved = await resolveTitleModel(ctx, modelRef, config);
	if (!resolved || signal.aborted) return undefined;

	const response = await complete(
		resolved.model,
		{
			systemPrompt: TITLE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildTitlePrompt(input, config.maxTitleChars) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: resolved.apiKey,
			headers: resolved.headers,
			cacheRetention: "none",
			maxRetries: config.maxRetries,
			maxTokens: config.maxTokens,
			signal,
			timeoutMs: config.timeoutMs,
		},
	);

	return sanitizeSessionTitle(responseText(response), config.maxTitleChars);
}

export default function sessionTitle(pi: ExtensionAPI) {
	let config: SessionTitleConfig | undefined;
	let sessionId: string | undefined;
	let controller: AbortController | undefined;
	let lastRenderedName: string | undefined;
	let lastRenderedTitle: string | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	const refreshTimers = new Set<ReturnType<typeof setTimeout>>();
	let pendingGeneration: PendingGeneration | undefined;
	let forkTitleState: ForkTitleState | undefined;

	function abortCurrentRequest(): void {
		controller?.abort();
		controller = undefined;
	}

	function clearRetryTimer(): void {
		if (!retryTimer) return;
		clearTimeout(retryTimer);
		retryTimer = undefined;
	}

	function clearRefreshTimers(): void {
		for (const timer of refreshTimers) clearTimeout(timer);
		refreshTimers.clear();
	}

	function currentSessionName(ctx?: ExtensionContext): string | undefined {
		const name = pi.getSessionName() ?? ctx?.sessionManager.getSessionName?.();
		return name?.trim() || undefined;
	}

	function shouldGeneratePendingTitle(ctx: ExtensionContext): boolean {
		if (!pendingGeneration) return false;
		if (pendingGeneration.sessionId !== ctx.sessionManager.getSessionId()) return false;
		const name = currentSessionName(ctx);
		if (!name) return true;
		if (pendingGeneration.provisionalSessionName && name === pendingGeneration.provisionalSessionName) return true;
		return Boolean(pendingGeneration.replaceSessionName && name === pendingGeneration.replaceSessionName);
	}

	function advancePendingGeneration(currentConfig: SessionTitleConfig): boolean {
		if (!pendingGeneration) return false;
		while (pendingGeneration.attempts >= currentConfig.generationAttempts) {
			if (pendingGeneration.modelIndex >= pendingGeneration.modelRefs.length - 1) return false;
			pendingGeneration.modelIndex++;
			pendingGeneration.attempts = 0;
		}
		return pendingGeneration.modelIndex < pendingGeneration.modelRefs.length;
	}

	function renderTerminalTitle(ctx: ExtensionContext, name: string | undefined, force = false): void {
		if (!ctx.hasUI || !config?.enabled || !config.terminalTitle) return;
		const title = name ? `${config.terminalTitlePrefix}${name}` : DEFAULT_TERMINAL_TITLE;
		const safeTitle = terminalSafeText(title) || DEFAULT_TERMINAL_TITLE;
		if (!force && safeTitle === lastRenderedTitle) return;
		ctx.ui.setTitle(safeTitle);
		lastRenderedTitle = safeTitle;
	}

	function refreshSessionUi(ctx: ExtensionContext, options: { force?: boolean; reapplyTitle?: boolean } = {}): void {
		const name = currentSessionName(ctx);
		const nameChanged = name !== lastRenderedName;
		if (options.force || nameChanged) {
			lastRenderedName = name;
		}
		if (options.force || options.reapplyTitle || nameChanged) {
			renderTerminalTitle(ctx, name, options.force || options.reapplyTitle);
		}
	}

	function scheduleSessionUiRefresh(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		clearRefreshTimers();
		for (const delayMs of [0, 100, 500, 1500, 3000]) {
			const timer = setTimeout(() => {
				refreshTimers.delete(timer);
				refreshSessionUi(ctx, { reapplyTitle: true });
			}, delayMs);
			timer.unref?.();
			refreshTimers.add(timer);
		}
	}

	function scheduleGenerationRetry(ctx: ExtensionContext, currentConfig: SessionTitleConfig): void {
		clearRetryTimer();
		if (!pendingGeneration) return;
		if (!shouldGeneratePendingTitle(ctx)) return;
		if (!advancePendingGeneration(currentConfig)) return;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			startTitleGeneration(ctx, currentConfig);
		}, currentConfig.retryDelayMs);
		retryTimer.unref?.();
	}

	function applyFallbackSessionTitle(ctx: ExtensionContext, currentConfig: SessionTitleConfig, input: string, options: { force?: boolean } = {}): boolean {
		const currentName = currentSessionName(ctx);
		if (!options.force && currentName) return false;
		const fallbackTitle = fallbackSessionTitleFromInput(input, currentConfig.maxTitleChars);
		if (!fallbackTitle) return false;
		pi.setSessionName(fallbackTitle);
		refreshSessionUi(ctx, { force: true });
		scheduleSessionUiRefresh(ctx);
		return true;
	}

	function startTitleGeneration(ctx: ExtensionContext, currentConfig: SessionTitleConfig): void {
		if (!pendingGeneration) return;
		if (controller) return;
		if (!shouldGeneratePendingTitle(ctx)) return;
		if (!advancePendingGeneration(currentConfig)) {
			applyFallbackSessionTitle(ctx, currentConfig, pendingGeneration.input, {
				force: Boolean(pendingGeneration.replaceSessionName),
			});
			pendingGeneration = undefined;
			return;
		}

		const modelRef = pendingGeneration.modelRefs[pendingGeneration.modelIndex];
		pendingGeneration.attempts++;
		abortCurrentRequest();
		controller = new AbortController();
		const requestController = controller;
		const currentSessionId = pendingGeneration.sessionId;
		const generation = { ...pendingGeneration, modelRef };

		void (async () => {
			try {
				const title = await generateSessionTitle(generation.input, ctx, currentConfig, generation.modelRef, requestController.signal);
				if (!title || requestController.signal.aborted) return;
				if (sessionId !== currentSessionId) return;
				if (!shouldGeneratePendingTitle(ctx)) return;
				pi.setSessionName(title);
				pendingGeneration = undefined;
				refreshSessionUi(ctx, { force: true });
				scheduleSessionUiRefresh(ctx);
				if (currentConfig.notify && ctx.hasUI) ctx.ui.notify(`Session named: ${title}`, "info");
			} catch (error) {
				if (requestController.signal.aborted) return;
				if (currentConfig.debug && ctx.hasUI) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Session title generation failed: ${message}`, "warning");
				}
			} finally {
				if (controller === requestController) controller = undefined;
				if (requestController.signal.aborted || pendingGeneration?.sessionId !== currentSessionId) return;
				if (shouldGeneratePendingTitle(ctx)) {
					if (!advancePendingGeneration(currentConfig)) {
						applyFallbackSessionTitle(ctx, currentConfig, generation.input, {
							force: Boolean(generation.replaceSessionName),
						});
						pendingGeneration = undefined;
						return;
					}
					scheduleGenerationRetry(ctx, currentConfig);
					return;
				}
			}
		})();
	}

	function isSameSessionPath(left: string | undefined, right: string | undefined): boolean {
		if (!left || !right) return false;
		if (left === right) return true;
		try {
			return resolve(left) === resolve(right);
		} catch {
			return false;
		}
	}

	async function resolveParentSessionTitle(options: {
		parentSessionFile: string | undefined;
		cwd: string;
		sessionDir: string;
		fallbackTitle: string | undefined;
	}): Promise<string | undefined> {
		const { parentSessionFile, cwd, sessionDir, fallbackTitle } = options;
		if (!parentSessionFile) return fallbackTitle;

		try {
			const directParentName = SessionManager.open(parentSessionFile).getSessionName()?.trim();
			if (directParentName) return directParentName;

			const sessions = await SessionManager.list(cwd, sessionDir);
			const parent = sessions.find((info) => isSameSessionPath(info.path, parentSessionFile));
			const parentName = parent?.name?.trim();
			if (parentName) return parentName;
		} catch {
			// Ignore lookup failures and keep the inherited session name as fallback.
		}

		return fallbackTitle;
	}

	function prepareForkTitleState(event: SessionStartEvent, ctx: ExtensionContext): void {
		forkTitleState = undefined;
		if (event.reason !== "fork") return;

		const currentSessionId = ctx.sessionManager.getSessionId();
		const inheritedSessionName = currentSessionName(ctx);
		const parentSessionFile = event.previousSessionFile ?? ctx.sessionManager.getHeader()?.parentSession;
		const cwd = ctx.cwd;
		const sessionDir = ctx.sessionManager.getSessionDir();
		forkTitleState = {
			sessionId: currentSessionId,
			parentTitle: inheritedSessionName,
			inheritedSessionName,
		};

		void resolveParentSessionTitle({
			parentSessionFile,
			cwd,
			sessionDir,
			fallbackTitle: inheritedSessionName,
		}).then((parentTitle) => {
			if (sessionId !== currentSessionId) return;
			if (forkTitleState?.sessionId !== currentSessionId) return;
			forkTitleState = {
				sessionId: currentSessionId,
				parentTitle,
				inheritedSessionName,
			};
		});
	}

	pi.on("session_start", async (event, ctx) => {
		abortCurrentRequest();
		clearRetryTimer();
		clearRefreshTimers();
		config = loadSessionTitleConfig(ctx.cwd);
		sessionId = ctx.sessionManager.getSessionId();
		pendingGeneration = undefined;
		forkTitleState = undefined;
		lastRenderedName = undefined;
		lastRenderedTitle = undefined;
		refreshSessionUi(ctx, { force: true });
		scheduleSessionUiRefresh(ctx);
		prepareForkTitleState(event, ctx);
	});

	pi.on("session_shutdown", async () => {
		abortCurrentRequest();
		clearRetryTimer();
		clearRefreshTimers();
		forkTitleState = undefined;
	});

	function refreshOnEvent(ctx: ExtensionContext): void {
		refreshSessionUi(ctx);
		scheduleSessionUiRefresh(ctx);
	}
	pi.on("agent_start", async (_event, ctx) => refreshOnEvent(ctx));
	pi.on("agent_end", async (_event, ctx) => refreshOnEvent(ctx));
	pi.on("turn_start", async (_event, ctx) => refreshOnEvent(ctx));
	pi.on("turn_end", async (_event, ctx) => refreshOnEvent(ctx));
	pi.on("session_tree", async (_event, ctx) => refreshOnEvent(ctx));
	pi.on("session_compact", async (_event, ctx) => refreshOnEvent(ctx));

	pi.on("input", async (event, ctx) => {
		const currentConfig = config ?? loadSessionTitleConfig(ctx.cwd);
		config = currentConfig;
		refreshSessionUi(ctx);
		scheduleSessionUiRefresh(ctx);
		if (event.source === "extension") return { action: "continue" as const };
		if (!event.text.trim()) return { action: "continue" as const };
		if (event.text.trimStart().startsWith("/")) return { action: "continue" as const };
		const currentSessionId = ctx.sessionManager.getSessionId();
		sessionId = currentSessionId;
		const currentName = currentSessionName(ctx);
		const activeForkTitleState = forkTitleState?.sessionId === currentSessionId ? forkTitleState : undefined;
		if (!activeForkTitleState && hasExistingUserMessage(ctx)) {
			forkTitleState = undefined;
			return { action: "continue" as const };
		}
		if (currentName && (!activeForkTitleState || currentName !== activeForkTitleState.inheritedSessionName)) {
			forkTitleState = undefined;
			return { action: "continue" as const };
		}
		if (!currentConfig.enabled) {
			applyFallbackSessionTitle(ctx, currentConfig, activeForkTitleState
				? buildForkTitleInput(activeForkTitleState.parentTitle, event.text)
				: event.text,
				{ force: Boolean(activeForkTitleState) });
			forkTitleState = undefined;
			return { action: "continue" as const };
		}

		if (!pendingGeneration || pendingGeneration.sessionId !== currentSessionId) {
			const input = activeForkTitleState
				? buildForkTitleInput(activeForkTitleState.parentTitle, event.text)
				: event.text;
			const provisionalSessionName = fallbackSessionTitleFromInput(input, currentConfig.maxTitleChars);
			if (provisionalSessionName && (!currentName || activeForkTitleState)) {
				pi.setSessionName(provisionalSessionName);
				refreshSessionUi(ctx, { force: true });
				scheduleSessionUiRefresh(ctx);
			}
			pendingGeneration = {
				sessionId: currentSessionId,
				input: truncateInput(input, currentConfig.maxInputChars),
				modelRefs: sessionTitleModelRefs(currentConfig),
				modelIndex: 0,
				attempts: 0,
				replaceSessionName: activeForkTitleState?.inheritedSessionName,
				provisionalSessionName,
			};
			forkTitleState = undefined;
		}

		startTitleGeneration(ctx, currentConfig);

		return { action: "continue" as const };
	});
}
