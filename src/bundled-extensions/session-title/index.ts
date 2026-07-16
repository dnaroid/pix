import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { ImageContent } from "../../input-editor.js";
import { loadSessionTitleConfig, type SessionTitleConfig } from "./config.js";
import {
	fallbackSessionTitleFromInput,
	firstUserMessageText as firstUserMessageTextFromEntries,
	sessionTitleModelRefs,
} from "./title-generation.js";
import { generateSessionTitle } from "./title-generation-compat.js";

export { generateSessionTitle } from "./title-generation-compat.js";
export { fallbackSessionTitleFromInput, generateSessionTitleWithRuntime, sessionTitleModelRefs, sanitizeSessionTitle } from "./title-generation.js";

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

function isStaleExtensionContextError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /ctx is stale|stale ctx|stale after session replacement|stale after.*reload/i.test(error.message);
}

function ignoreStaleExtensionContextError(error: unknown): void {
	if (!isStaleExtensionContextError(error)) throw error;
}

function staleSafe<T>(callback: () => T): T | undefined {
	try {
		return callback();
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return undefined;
	}
}

function imageAttachmentLabel(images: readonly ImageContent[]): string | undefined {
	if (images.length === 0) return undefined;
	return images.length === 1 ? "Attached image" : `Attached images (${images.length})`;
}

function fallbackTitleInputFromPrompt(text: string, images: readonly ImageContent[] = []): string | undefined {
	const trimmedText = text.trim();
	return trimmedText || imageAttachmentLabel(images);
}

function titleGenerationInputFromPrompt(text: string, images: readonly ImageContent[] = []): string | undefined {
	const trimmedText = text.trim();
	const imageLabel = imageAttachmentLabel(images);
	if (trimmedText && imageLabel) return `${trimmedText}\n\n${imageLabel}`;
	return trimmedText || imageLabel;
}

export function firstUserMessageText(ctx: ExtensionContext): string | undefined {
	return firstUserMessageTextFromEntries(ctx.sessionManager.getBranch() as Parameters<typeof firstUserMessageTextFromEntries>[0]);
}

function hasExistingUserMessage(ctx: ExtensionContext): boolean {
	return firstUserMessageText(ctx) !== undefined;
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

	function safeCtxCall<T>(callback: () => T): T | undefined {
		return staleSafe(callback);
	}

	function safePiCall<T>(callback: () => T): T | undefined {
		return staleSafe(callback);
	}

	function currentSessionId(ctx: ExtensionContext): string | undefined {
		return safeCtxCall(() => ctx.sessionManager.getSessionId());
	}

	function currentSessionName(ctx?: ExtensionContext): string | undefined {
		const name = safePiCall(() => pi.getSessionName()) ?? safeCtxCall(() => ctx?.sessionManager.getSessionName?.());
		return name?.trim() || undefined;
	}

	function shouldGeneratePendingTitle(ctx: ExtensionContext): boolean {
		if (!pendingGeneration) return false;
		if (pendingGeneration.sessionId !== currentSessionId(ctx)) return false;
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
		const rendered = safeCtxCall(() => {
			ctx.ui.setTitle(safeTitle);
			return true;
		});
		if (!rendered) return;
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
				safeCtxCall(() => refreshSessionUi(ctx, { reapplyTitle: true }));
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
			safeCtxCall(() => startTitleGeneration(ctx, currentConfig));
		}, currentConfig.retryDelayMs);
		retryTimer.unref?.();
	}

	function applyFallbackSessionTitle(ctx: ExtensionContext, currentConfig: SessionTitleConfig, input: string, options: { force?: boolean } = {}): boolean {
		const currentName = currentSessionName(ctx);
		if (!options.force && currentName) return false;
		const fallbackTitle = fallbackSessionTitleFromInput(input, currentConfig.maxTitleChars);
		if (!fallbackTitle) return false;
		if (!safePiCall(() => {
			pi.setSessionName(fallbackTitle);
			return true;
		})) return false;
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
		if (!modelRef) {
			pendingGeneration = undefined;
			return;
		}
		pendingGeneration.attempts++;
		abortCurrentRequest();
		controller = new AbortController();
		const requestController = controller;
		const pendingSessionId = pendingGeneration.sessionId;
		const generation = { ...pendingGeneration, modelRef };

		void (async () => {
			try {
				const notifyDebug = currentConfig.debug && ctx.hasUI
					? (message: string) => {
						safeCtxCall(() => ctx.ui.notify(message, "warning"));
					}
					: undefined;
				const title = await generateSessionTitle(
					generation.input,
					ctx.modelRegistry,
					currentConfig,
					generation.modelRef,
					requestController.signal,
					notifyDebug,
				);
				if (!title || requestController.signal.aborted) return;
				if (sessionId !== pendingSessionId) return;
				if (pendingSessionId !== currentSessionId(ctx)) return;
				if (!shouldGeneratePendingTitle(ctx)) return;
				if (!safePiCall(() => {
					pi.setSessionName(title);
					return true;
				})) return;
				pendingGeneration = undefined;
				refreshSessionUi(ctx, { force: true });
				scheduleSessionUiRefresh(ctx);
				if (currentConfig.notify && ctx.hasUI) safeCtxCall(() => ctx.ui.notify(`Session named: ${title}`, "info"));
			} catch (error) {
				if (requestController.signal.aborted) return;
				if (currentConfig.debug && ctx.hasUI) {
					const message = error instanceof Error ? error.message : String(error);
					safeCtxCall(() => ctx.ui.notify(`Session title generation failed: ${message}`, "warning"));
				}
			} finally {
				if (controller === requestController) controller = undefined;
				if (requestController.signal.aborted || pendingGeneration?.sessionId !== pendingSessionId) return;
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
		const fallbackInput = fallbackTitleInputFromPrompt(event.text, event.images);
		if (!fallbackInput) return { action: "continue" as const };
		const titleInput = titleGenerationInputFromPrompt(event.text, event.images) ?? fallbackInput;
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
				? buildForkTitleInput(activeForkTitleState.parentTitle, fallbackInput)
				: fallbackInput,
				{ force: Boolean(activeForkTitleState) });
			forkTitleState = undefined;
			return { action: "continue" as const };
		}

		if (!pendingGeneration || pendingGeneration.sessionId !== currentSessionId) {
			const input = activeForkTitleState
				? buildForkTitleInput(activeForkTitleState.parentTitle, titleInput)
				: titleInput;
			const fallbackTitleInput = activeForkTitleState
				? buildForkTitleInput(activeForkTitleState.parentTitle, fallbackInput)
				: fallbackInput;
			const provisionalSessionName = fallbackSessionTitleFromInput(fallbackTitleInput, currentConfig.maxTitleChars);
			if (provisionalSessionName && (!currentName || activeForkTitleState)) {
				if (!safePiCall(() => {
					pi.setSessionName(provisionalSessionName);
					return true;
				})) return { action: "continue" as const };
				refreshSessionUi(ctx, { force: true });
				scheduleSessionUiRefresh(ctx);
			}
			pendingGeneration = {
				sessionId: currentSessionId,
				input: truncateInput(input, currentConfig.maxInputChars),
				modelRefs: sessionTitleModelRefs(currentConfig),
				modelIndex: 0,
				attempts: 0,
				...(activeForkTitleState?.inheritedSessionName === undefined ? {} : { replaceSessionName: activeForkTitleState.inheritedSessionName }),
				...(provisionalSessionName === undefined ? {} : { provisionalSessionName }),
			};
			forkTitleState = undefined;
		}

		startTitleGeneration(ctx, currentConfig);

		return { action: "continue" as const };
	});
}
