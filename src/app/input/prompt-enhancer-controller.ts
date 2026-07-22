import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
	type AgentSessionEvent,
	type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import type { PromptEnhancerConfig } from "../../config.js";
import type { InputEditor } from "../../input-editor.js";
import type { ToastNotifier } from "../../ui.js";
import { APP_ICONS } from "../icons.js";
import { stringifyUnknown } from "../rendering/message-content.js";
import { parseModelRef } from "../model/model-ref.js";
import type { TabInputState } from "../session/tabs-controller.js";
import type { SessionActivity, SessionModel } from "../types.js";

const PROMPT_ENHANCER_SYSTEM_PROMPT = `You improve prompts for a coding agent.

Rewrite the user's draft into a clearer, more actionable prompt.
Preserve the user's intent and language.
Do not solve the task.
Do not add unsupported assumptions.
Add useful constraints, acceptance criteria, and context requests when helpful.
Output only the improved prompt. No commentary, no markdown fences.`;

const PROMPT_ENHANCER_MIN_TEXT_LENGTH = 3;

export type AppPromptEnhancerControllerHost = {
	runtime(): AgentSessionRuntime | undefined;
	inputEditor(): InputEditor;
	activeInputTabId(): string | undefined;
	isInputTabOwnedByRuntime(tabId: string | undefined, runtime: AgentSessionRuntime, session: AgentSessionRuntime["session"]): boolean;
	inputStateForTab(tabId: string | undefined): TabInputState | undefined;
	setInputStateForTab(tabId: string | undefined, state: TabInputState): void;
	promptEnhancerConfig(): PromptEnhancerConfig;
	resetInputAfterProgrammaticEdit(): void;
	setStatus(status: string): void;
	setSessionStatus(session: AgentSessionRuntime["session"] | undefined): void;
	setSessionActivity(activity: SessionActivity): void;
	toast: ToastNotifier;
	render(): void;
};

type PromptEnhanceTarget = {
	kind: "selection" | "input";
	tabId: string | undefined;
	text: string;
	originalEditorText: string;
	start: number;
	end: number;
};

type PromptEnhanceRunner = typeof enhancePromptWithPi;

type PromptEnhancerPiDeps = {
	createAgentSessionServices: typeof createAgentSessionServices;
	createAgentSessionFromServices: typeof createAgentSessionFromServices;
	sessionManagerInMemory: typeof SessionManager.inMemory;
};

const defaultPromptEnhancerPiDeps: PromptEnhancerPiDeps = {
	createAgentSessionServices,
	createAgentSessionFromServices,
	sessionManagerInMemory: SessionManager.inMemory,
};

let promptEnhancerPiDeps = defaultPromptEnhancerPiDeps;

export function setPromptEnhancerPiTestDeps(overrides?: Partial<PromptEnhancerPiDeps>): void {
	promptEnhancerPiDeps = overrides ? { ...defaultPromptEnhancerPiDeps, ...overrides } : defaultPromptEnhancerPiDeps;
}

type AppPromptEnhancerControllerOptions = {
	enhancePromptWithPi?: PromptEnhanceRunner;
};

export class AppPromptEnhancerController {
	private enhancing = false;
	private readonly enhancePromptWithPi: PromptEnhanceRunner;

	constructor(
		private readonly host: AppPromptEnhancerControllerHost,
		options: AppPromptEnhancerControllerOptions = {},
	) {
		this.enhancePromptWithPi = options.enhancePromptWithPi ?? enhancePromptWithPi;
	}

	statusWidgetText(): string {
		return this.enhancing ? APP_ICONS.timerSand : APP_ICONS.autoFix;
	}

	statusWidgetActive(): boolean {
		return this.enhancing;
	}

	statusWidgetEnabled(): boolean {
		return this.enhancing || this.currentTarget() !== undefined;
	}

	async enhancePrompt(): Promise<void> {
		if (this.enhancing) {
			this.host.toast.warning("Prompt enhancement is already running");
			return;
		}

		const runtime = this.host.runtime();
		if (!runtime) {
			this.host.toast.error("Prompt enhancer unavailable: runtime is not initialized");
			return;
		}
		const session = runtime.session;

		const target = this.currentTarget();
		if (!target) {
			this.host.toast.warning(`Type at least ${PROMPT_ENHANCER_MIN_TEXT_LENGTH} characters to enhance`);
			return;
		}

		this.enhancing = true;
		this.host.setStatus("enhancing prompt");
		this.host.setSessionActivity("thinking");
		this.host.render();

		try {
			const enhanced = await this.enhancePromptWithPi(runtime, target.text, this.host.promptEnhancerConfig());
			if (!this.host.isInputTabOwnedByRuntime(target.tabId, runtime, session)) return;
			const currentInputState = this.host.inputStateForTab(target.tabId);
			if (!currentInputState || currentInputState.text !== target.originalEditorText) {
				this.host.toast.warning("Prompt was changed before enhancement completed; result was not applied");
				return;
			}

			this.applyEnhancedPrompt(target, enhanced, currentInputState);
			this.host.resetInputAfterProgrammaticEdit();
			this.host.toast.success(target.kind === "selection" ? "Selection enhanced" : "Prompt enhanced");
		} catch (error) {
			if (!this.host.isInputTabOwnedByRuntime(target.tabId, runtime, session)) return;
			this.host.toast.error(`Prompt enhance failed: ${stringifyUnknown(error)}`);
		} finally {
			this.enhancing = false;
			if (this.host.runtime() === runtime && runtime.session === session) this.restoreSessionState(session);
			this.host.render();
		}
	}

	private currentTarget(): PromptEnhanceTarget | undefined {
		const editor = this.host.inputEditor();
		const tabId = this.host.activeInputTabId();
		const originalEditorText = editor.text;
		const selectedText = editor.getSelectedText();

		if (selectedText !== undefined && selectedText.trim().length > 0 && editor.selection) {
			if (!promptEnhancerTextIsSufficient(selectedText)) return undefined;
			const start = Math.min(editor.selection.anchor, editor.selection.active);
			const end = Math.max(editor.selection.anchor, editor.selection.active);
			return {
				kind: "selection",
				tabId,
				text: selectedText,
				originalEditorText,
				start,
				end,
			};
		}

		if (!promptEnhancerTextIsSufficient(originalEditorText)) return undefined;
		return {
			kind: "input",
			tabId,
			text: originalEditorText,
			originalEditorText,
			start: 0,
			end: originalEditorText.length,
		};
	}

	private applyEnhancedPrompt(target: PromptEnhanceTarget, enhanced: string, currentState: TabInputState): void {
		const nextText = `${target.originalEditorText.slice(0, target.start)}${enhanced}${target.originalEditorText.slice(target.end)}`;
		this.host.setInputStateForTab(target.tabId, {
			text: nextText,
			cursor: target.start + enhanced.length,
			...(currentState.attachments ? { attachments: currentState.attachments } : {}),
		});
	}

	private restoreSessionState(session: AgentSessionRuntime["session"]): void {
		this.host.setSessionStatus(session);
		this.host.setSessionActivity(session?.isStreaming || session?.isCompacting ? "running" : "idle");
	}
}

export function promptEnhancerTextIsSufficient(text: string): boolean {
	return text.trim().length >= PROMPT_ENHANCER_MIN_TEXT_LENGTH;
}

async function enhancePromptWithPi(
	runtime: AgentSessionRuntime,
	draft: string,
	config: PromptEnhancerConfig,
): Promise<string> {
	const parsedModel = parseModelRef(config.modelRef);
	const services = await promptEnhancerPiDeps.createAgentSessionServices({
		cwd: runtime.cwd,
		agentDir: runtime.services.agentDir,
		settingsManager: runtime.services.settingsManager,
		modelRuntime: runtime.services.modelRuntime,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: PROMPT_ENHANCER_SYSTEM_PROMPT,
		},
	});

	await services.modelRuntime.reloadConfig();
	const model = services.modelRuntime.getModel(parsedModel.provider, parsedModel.modelId) as SessionModel | undefined;
	if (!model) {
		throw new Error(modelNotFoundMessage(
			parsedModel.provider,
			parsedModel.modelId,
			services.modelRuntime.getModels() as SessionModel[],
		));
	}

	const { session } = await promptEnhancerPiDeps.createAgentSessionFromServices({
		services,
		sessionManager: promptEnhancerPiDeps.sessionManagerInMemory(runtime.cwd),
		model,
		thinkingLevel: parsedModel.thinkingLevel ?? "minimal",
		noTools: "all",
	});

	let output = "";
	let streamError: string | undefined;
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type !== "message_update") return;
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type === "text_delta") output += assistantEvent.delta;
		else if (assistantEvent.type === "error") streamError = assistantEvent.error.errorMessage ?? assistantEvent.reason;
	});

	try {
		await session.prompt(buildEnhancerPrompt(draft), { expandPromptTemplates: false });
		if (streamError) throw new Error(streamError);
		const cleaned = cleanupEnhancedPrompt(output);
		if (cleaned.length === 0) throw new Error("model returned an empty prompt");
		return cleaned;
	} finally {
		unsubscribe();
		session.dispose();
	}
}

function buildEnhancerPrompt(draft: string): string {
	return [
		"Rewrite this draft prompt. Output only the improved prompt.",
		"<draft>",
		draft,
		"</draft>",
	].join("\n");
}

function cleanupEnhancedPrompt(output: string): string {
	let text = output.replace(/\r\n/gu, "\n").trim();
	const fenced = /^```[^\n`]*\n([\s\S]*?)\n```$/u.exec(text);
	if (fenced) text = fenced[1]!.trim();
	return text;
}

function modelNotFoundMessage(provider: string, modelId: string, models: readonly SessionModel[]): string {
	const requested = `${provider}/${modelId}`;
	const suggestions = suggestModelRefs(provider, modelId, models);
	return suggestions.length > 0
		? `Model not found: ${requested}. Did you mean ${suggestions.join(", ")}?`
		: `Model not found: ${requested}`;
}

function suggestModelRefs(provider: string, modelId: string, models: readonly SessionModel[]): string[] {
	const queryTokens = tokenSet(`${provider} ${modelId}`);
	return models
		.map((model) => ({ ref: `${model.provider}/${model.id}`, score: modelSuggestionScore(model, provider, modelId, queryTokens) }))
		.filter((candidate) => candidate.score > 0)
		.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
		.slice(0, 3)
		.map((candidate) => candidate.ref);
}

function modelSuggestionScore(model: SessionModel, provider: string, modelId: string, queryTokens: ReadonlySet<string>): number {
	let score = 0;
	if (model.provider === provider) score += 8;
	if (model.id === modelId) score += 8;
	for (const token of tokenSet(`${model.provider} ${model.id} ${model.name ?? ""}`)) {
		if (queryTokens.has(token)) score += 1;
	}
	return score;
}

function tokenSet(value: string): Set<string> {
	return new Set(value.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length > 0));
}
