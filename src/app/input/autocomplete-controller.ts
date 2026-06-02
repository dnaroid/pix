import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
	type AgentSessionEvent,
	type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteConfig } from "../../config.js";
import type { InputEditor } from "../../input-editor.js";
import { parseModelRef } from "../model/model-ref.js";
import type { SessionModel } from "../types.js";

const AUTOCOMPLETE_DEBOUNCE_MS = 450;
const AUTOCOMPLETE_MIN_TEXT_LENGTH = 3;
const AUTOCOMPLETE_MAX_SUFFIX_LENGTH = 600;

const AUTOCOMPLETE_SYSTEM_PROMPT = `You are an inline autocomplete engine for a coding-agent terminal input.
Continue the user's draft at the cursor.
Output only the exact text to append after the cursor.
Do not repeat the draft.
Do not add explanations, markdown fences, or alternatives.
Keep the completion concise and useful.`;

export type AppAutocompleteControllerHost = {
	runtime(): AgentSessionRuntime | undefined;
	inputEditor(): InputEditor;
	autocompleteConfig(): AutocompleteConfig;
	isRunning(): boolean;
	render(): void;
};

type AutocompleteTarget = {
	text: string;
	cursor: number;
};

type AutocompleteRunner = typeof completeInputWithPi;

export type AppAutocompleteControllerOptions = {
	completeInputWithPi?: AutocompleteRunner;
	debounceMs?: number;
};

export class AppAutocompleteController {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private lastObservedKey = "";
	private requestSeq = 0;
	private suggestion: { target: AutocompleteTarget; text: string } | undefined;
	private readonly completeInputWithPi: AutocompleteRunner;
	private readonly debounceMs: number;

	constructor(
		private readonly host: AppAutocompleteControllerHost,
		options: AppAutocompleteControllerOptions = {},
	) {
		this.completeInputWithPi = options.completeInputWithPi ?? completeInputWithPi;
		this.debounceMs = options.debounceMs ?? AUTOCOMPLETE_DEBOUNCE_MS;
	}

	observeInput(): void {
		const target = this.currentTarget();
		const key = target ? this.targetKey(target) : "";
		if (key === this.lastObservedKey) return;

		this.lastObservedKey = key;
		this.suggestion = undefined;
		this.clearTimer();
		if (!target) return;

		const requestSeq = ++this.requestSeq;
		this.timer = setTimeout(() => {
			void this.runAutocomplete(target, requestSeq);
		}, this.debounceMs);
		this.timer.unref?.();
	}

	suggestionText(): string | undefined {
		const target = this.currentTarget();
		if (!target || !this.suggestion) return undefined;
		return this.sameTarget(target, this.suggestion.target) ? this.suggestion.text : undefined;
	}

	acceptSuggestion(): boolean {
		const suggestion = this.suggestionText();
		if (!suggestion) return false;

		this.host.inputEditor().insert(suggestion);
		this.suggestion = undefined;
		this.lastObservedKey = "";
		this.clearTimer();
		this.host.render();
		return true;
	}

	dispose(): void {
		this.clearTimer();
		this.requestSeq += 1;
		this.suggestion = undefined;
	}

	private async runAutocomplete(target: AutocompleteTarget, requestSeq: number): Promise<void> {
		const runtime = this.host.runtime();
		const config = this.host.autocompleteConfig();
		if (!runtime || !config.modelRef.trim()) return;

		try {
			const completion = await this.completeInputWithPi(runtime, target.text, config);
			if (requestSeq !== this.requestSeq) return;
			const current = this.currentTarget();
			if (!current || !this.sameTarget(current, target)) return;

			const suggestion = cleanupCompletion(completion, target.text);
			if (!suggestion) return;
			this.suggestion = { target, text: suggestion };
			if (this.host.isRunning()) this.host.render();
		} catch {
			// Inline autocomplete is best-effort; avoid surfacing transient model/auth errors while typing.
		}
	}

	private currentTarget(): AutocompleteTarget | undefined {
		const config = this.host.autocompleteConfig();
		if (!config.modelRef.trim()) return undefined;

		const editor = this.host.inputEditor();
		const text = editor.text;
		const cursor = editor.cursor;
		if (editor.hasSelection || editor.hasAttachments) return undefined;
		if (cursor !== text.length) return undefined;
		if (text.trim().length < AUTOCOMPLETE_MIN_TEXT_LENGTH) return undefined;
		if (text.startsWith("/") || text.startsWith("!")) return undefined;
		return { text, cursor };
	}

	private targetKey(target: AutocompleteTarget): string {
		return `${target.cursor}\u0000${target.text}`;
	}

	private sameTarget(a: AutocompleteTarget, b: AutocompleteTarget): boolean {
		return a.cursor === b.cursor && a.text === b.text;
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}

async function completeInputWithPi(
	runtime: AgentSessionRuntime,
	draft: string,
	config: AutocompleteConfig,
): Promise<string> {
	const parsedModel = parseModelRef(config.modelRef);
	const services = await createAgentSessionServices({
		cwd: runtime.cwd,
		agentDir: runtime.services.agentDir,
		authStorage: runtime.services.authStorage,
		settingsManager: runtime.services.settingsManager,
		modelRegistry: runtime.services.modelRegistry,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: AUTOCOMPLETE_SYSTEM_PROMPT,
		},
	});

	services.modelRegistry.refresh();
	const model = services.modelRegistry.find(parsedModel.provider, parsedModel.modelId) as SessionModel | undefined;
	if (!model) throw new Error(`Model not found: ${parsedModel.provider}/${parsedModel.modelId}`);

	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(runtime.cwd),
		model,
		thinkingLevel: parsedModel.thinkingLevel ?? "off",
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
		await session.prompt(buildAutocompletePrompt(draft), { expandPromptTemplates: false });
		if (streamError) throw new Error(streamError);
		return output;
	} finally {
		unsubscribe();
		session.dispose();
	}
}

function buildAutocompletePrompt(draft: string): string {
	return [
		"Complete this terminal prompt. Output only the suffix to append after <cursor>.",
		"<draft>",
		draft,
		"<cursor>",
		"</draft>",
	].join("\n");
}

function cleanupCompletion(output: string, draft: string): string {
	let text = output.replace(/\r\n/gu, "\n").trimEnd();
	const fenced = /^```[^\n`]*\n([\s\S]*?)\n```$/u.exec(text.trim());
	if (fenced) text = fenced[1]!.trimEnd();
	if (text.startsWith(draft)) text = text.slice(draft.length);
	text = text.replace(/^<cursor>/u, "");
	return text.slice(0, AUTOCOMPLETE_MAX_SUFFIX_LENGTH);
}
