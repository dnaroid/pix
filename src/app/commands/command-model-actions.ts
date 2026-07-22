import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getIdleRuntime, getRuntime } from "./command-runtime.js";
import {
	captureCommandScope,
	isCommandScopeActive,
	type CommandControllerHost,
	type CommandScope,
} from "./command-host.js";
import { getProjectPixConfigPath, savePixAutocompleteModel, savePixDefaultModel, savePixDefaultThinking, saveProjectPixIgnoreContextFiles } from "../../config.js";
import { createId } from "../id.js";
import { isThinkingLevel, parseScopedModelRef } from "../model/model-ref.js";
import { appendPixSystemDisplayEntry } from "../session/pix-system-message.js";
import type { ScopedSessionModel, SessionModel, ThinkingLevel } from "../types.js";

export class ModelCommandActions {
	constructor(private readonly host: CommandControllerHost) {}

	async runSettingsCommand(): Promise<void> {
		const runtime = getRuntime(this.host, "settings");
		if (!runtime) return;

		const settings = runtime.services.settingsManager;
		const currentModel = runtime.session.model ? this.host.modelRef(runtime.session.model as SessionModel) : "not selected";
		const enabledModels = settings.getEnabledModels();
		const scopedModelText = enabledModels && enabledModels.length > 0
			? enabledModels.map((model) => `  - ${model}`).join("\n")
			: "  - default favorites";
		const text = [
			"Settings summary",
			`cwd: ${runtime.cwd}`,
			`session: ${runtime.session.sessionFile ?? "in-memory"}`,
			`model: ${currentModel}`,
			`prompt enhancer model: ${this.host.promptEnhancerModelRef()}`,
			`autocomplete model: ${this.host.autocompleteModelRef() || "disabled"}`,
			`context files: ${this.host.ignoreContextFiles() ? "disabled" : "enabled"}`,
			`thinking: ${runtime.session.thinkingLevel}`,
			`theme: ${settings.getTheme() ?? this.host.options.themeName}`,
			`skill commands: ${settings.getEnableSkillCommands() ? "enabled" : "disabled"}`,
			`auto compaction: ${runtime.session.autoCompactionEnabled ? "enabled" : "disabled"}`,
			`steering mode: ${runtime.session.steeringMode}`,
			`follow-up mode: ${runtime.session.followUpMode}`,
			"scoped models:",
			scopedModelText,
			"",
			"Use /model, /thinking, /no-context-files, /scoped-models, /export, /import, /reload for editable settings in pix.",
		].join("\n");
		this.host.addEntry({ id: createId("system"), kind: "system", text });
		this.host.setSessionStatus(runtime.session);
	}

	async runModelSlashCommand(argumentsText: string): Promise<void> {
		const scope = captureCommandScope(this.host);
		const modelRef = argumentsText.trim();
		if (!modelRef) {
			const selected = await this.host.showMenu(this.host.getModelMenuItems(""), {
				title: "Select model",
				placeholder: "Search models",
				emptyText: "No matching models",
			});
			if (!isCommandScopeActive(this.host, scope)) return;
			if (!selected) {
				this.host.setSessionStatus(this.host.runtime()?.session);
				this.host.render();
				return;
			}

			await this.runModelCommand(selected.model);
			this.host.render();
			return;
		}

		const runtime = getRuntime(this.host, "model");
		if (!runtime) return;

		const parsed = parseScopedModelRef(modelRef);
		if (!parsed) throw new Error("Model must use provider/model[:thinking] format");

		await runtime.services.modelRuntime.reloadConfig();
		if (!isCommandScopeActive(this.host, scope)) return;
		const model = runtime.services.modelRuntime.getModel(parsed.provider, parsed.modelId) as SessionModel | undefined;
		if (!model) throw new Error(`Model not found: ${parsed.provider}/${parsed.modelId}`);

		await this.runModelCommand(model);
		if (!isCommandScopeActive(this.host, scope)) return;
		if (parsed.thinkingLevel !== undefined) {
			runtime.session.setThinkingLevel(parsed.thinkingLevel);
			this.addPersistentSystemEntry(runtime.session, `Selected thinking level ${runtime.session.thinkingLevel}`);
			this.host.setSessionStatus(runtime.session);
		}
	}

	async runDefaultModelSlashCommand(argumentsText: string): Promise<void> {
		const scope = captureCommandScope(this.host);
		const modelRef = argumentsText.trim();
		if (!modelRef) {
			const selected = await this.host.showMenu(this.host.getModelMenuItems(""), {
				title: "Select default model",
				placeholder: "Search models",
				emptyText: "No matching models",
			});
			if (!isCommandScopeActive(this.host, scope)) return;
			if (!selected) {
				this.host.setSessionStatus(this.host.runtime()?.session);
				this.host.render();
				return;
			}

			this.saveDefaultModel(this.host.modelRef(selected.model));
			this.host.render();
			return;
		}

		const runtime = getRuntime(this.host, "default-model");
		if (!runtime) return;

		const parsed = parseScopedModelRef(modelRef);
		if (!parsed) throw new Error("Model must use provider/model[:thinking] format");

		await runtime.services.modelRuntime.reloadConfig();
		if (!isCommandScopeActive(this.host, scope)) return;
		const model = runtime.services.modelRuntime.getModel(parsed.provider, parsed.modelId) as SessionModel | undefined;
		if (!model) throw new Error(`Model not found: ${parsed.provider}/${parsed.modelId}`);

		this.saveDefaultModel(modelRef);
		this.host.setSessionStatus(runtime.session);
	}

	async runAutocompleteSlashCommand(argumentsText: string): Promise<void> {
		const scope = captureCommandScope(this.host);
		const modelRef = argumentsText.trim();
		if (!modelRef) {
			const saved = savePixAutocompleteModel("");
			this.host.setAutocompleteModelRef(saved.modelRef);
			this.host.addEntry({ id: createId("system"), kind: "system", text: saved.modelRef ? `Autocomplete model set to ${saved.modelRef}` : "Inline autocomplete disabled." });
			return;
		}

		const runtime = getRuntime(this.host, "autocomplete");
		if (!runtime) return;

		const parsed = parseScopedModelRef(modelRef);
		if (!parsed) throw new Error("Model must use provider/model[:thinking] format, or run /autocomplete with no arguments to disable");

		await runtime.services.modelRuntime.reloadConfig();
		if (!isCommandScopeActive(this.host, scope)) return;
		const model = runtime.services.modelRuntime.getModel(parsed.provider, parsed.modelId) as SessionModel | undefined;
		if (!model) throw new Error(`Model not found: ${parsed.provider}/${parsed.modelId}`);

		const saved = savePixAutocompleteModel(modelRef);
		this.host.setAutocompleteModelRef(saved.modelRef);
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Autocomplete model set to ${saved.modelRef}.` });
		this.host.setSessionStatus(runtime.session);
	}

	async runNoContextFilesSlashCommand(argumentsText: string): Promise<void> {
		const value = argumentsText.trim().toLowerCase();
		if (!value) {
			this.host.addEntry({
				id: createId("system"),
				kind: "system",
				text: [
					`Context file loading is currently ${this.host.ignoreContextFiles() ? "disabled" : "enabled"} for this project.`,
					"Usage: /no-context-files <on|off>",
				].join("\n"),
			});
			this.host.setSessionStatus(this.host.runtime()?.session);
			return;
		}

		if (value !== "on" && value !== "off") throw new Error("Usage: /no-context-files <on|off>");

		const ignoreContextFiles = value === "on";
		const saved = saveProjectPixIgnoreContextFiles(this.host.options.cwd, ignoreContextFiles);
		this.host.setIgnoreContextFiles(saved);
		this.host.addEntry({
			id: createId("system"),
			kind: "system",
			text: [
				`Context file loading ${saved ? "disabled" : "enabled"} for this project.`,
				`Saved ignoreContextFiles=${saved ? "true" : "false"} to ${getProjectPixConfigPath(this.host.options.cwd)}.`,
				"Start a new session or restart Pix for the change to affect loaded AGENTS.md/CLAUDE.md context.",
			].join("\n"),
		});
		this.host.setSessionStatus(this.host.runtime()?.session);
	}

	async runScopedModelsCommand(argumentsText: string): Promise<void> {
		const runtime = getIdleRuntime(this.host, "scoped-models");
		if (!runtime) return;
		const scope = captureCommandScope(this.host);

		const value = argumentsText.trim();
		if (!value) {
			const enabledModels = runtime.services.settingsManager.getEnabledModels();
			const sessionModels = runtime.session.scopedModels.map((scoped) => {
				const suffix = scoped.thinkingLevel === undefined ? "" : `:${scoped.thinkingLevel}`;
				return `  - ${this.host.modelRef(scoped.model as SessionModel)}${suffix}`;
			});
			let scopedModelLines: string[];
			if (enabledModels && enabledModels.length > 0) scopedModelLines = enabledModels.map((model) => `  - ${model}`);
			else if (sessionModels.length > 0) scopedModelLines = sessionModels;
			else scopedModelLines = ["  - default favorites"];
			this.host.addEntry({
				id: createId("system"),
				kind: "system",
				text: [
					"Scoped models",
					...scopedModelLines,
					"",
					"Usage: /scoped-models <provider/model[:thinking]> [...more]",
					"Use /scoped-models reset to restore the default favorites.",
				].join("\n"),
			});
			this.host.setSessionStatus(runtime.session);
			return;
		}

		if (["reset", "default", "clear"].includes(value.toLowerCase())) {
			runtime.services.settingsManager.setEnabledModels(undefined);
			runtime.session.setScopedModels(this.host.getFavoriteScopedModels());
			this.host.addEntry({ id: createId("system"), kind: "system", text: "Scoped models reset to default favorites." });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		const refs = value.split(/[,\s]+/).map((ref) => ref.trim()).filter(Boolean);
		const scopedModels: ScopedSessionModel[] = [];
		const invalidRefs: string[] = [];
		await runtime.services.modelRuntime.reloadConfig();
		if (!isCommandScopeActive(this.host, scope)) return;
		for (const ref of refs) {
			const parsed = parseScopedModelRef(ref);
			const model = parsed ? runtime.services.modelRuntime.getModel(parsed.provider, parsed.modelId) as SessionModel | undefined : undefined;
			if (!parsed || !model) {
				invalidRefs.push(ref);
				continue;
			}
			scopedModels.push({ model, ...(parsed.thinkingLevel === undefined ? {} : { thinkingLevel: parsed.thinkingLevel }) });
		}

		if (invalidRefs.length > 0) throw new Error(`Unknown model reference(s): ${invalidRefs.join(", ")}`);
		if (scopedModels.length === 0) throw new Error("No model references provided");

		runtime.services.settingsManager.setEnabledModels(refs);
		runtime.session.setScopedModels(scopedModels);
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Scoped models set:\n${refs.map((ref) => `  - ${ref}`).join("\n")}` });
		this.host.setSessionStatus(runtime.session);
	}

	async runThinkingSlashCommand(argumentsText: string): Promise<void> {
		const scope = captureCommandScope(this.host);
		const level = argumentsText.trim();
		if (!level) {
			const selected = await this.host.showMenu(this.host.getThinkingMenuItems(""), {
				title: "Select thinking level",
				placeholder: "Search thinking levels",
				emptyText: "No matching thinking levels",
			});
			if (!isCommandScopeActive(this.host, scope)) return;
			if (!selected) {
				this.host.setSessionStatus(this.host.runtime()?.session);
				this.host.render();
				return;
			}

			await this.runThinkingCommand(selected.level);
			this.host.render();
			return;
		}

		if (!isThinkingLevel(level)) throw new Error(`Unknown thinking level: ${level}`);
		await this.runThinkingCommand(level);
	}

	async runDefaultThinkingSlashCommand(argumentsText: string): Promise<void> {
		const scope = captureCommandScope(this.host);
		const level = argumentsText.trim();
		if (!level) {
			const selected = await this.host.showMenu(this.host.getThinkingMenuItems(""), {
				title: "Select default thinking level",
				placeholder: "Search thinking levels",
				emptyText: "No matching thinking levels",
			});
			if (!isCommandScopeActive(this.host, scope)) return;
			if (!selected) {
				this.host.setSessionStatus(this.host.runtime()?.session);
				this.host.render();
				return;
			}

			this.saveDefaultThinking(selected.level);
			this.host.render();
			return;
		}

		if (!isThinkingLevel(level)) throw new Error(`Unknown thinking level: ${level}`);
		this.saveDefaultThinking(level);
	}

	async runModelCommand(model: SessionModel): Promise<void> {
		const runtime = getRuntime(this.host, "model");
		if (!runtime) return;
		const scope = captureCommandScope(this.host);

		const ref = this.host.modelRef(model);
		this.host.setStatus(`selecting model ${ref}`);
		this.host.render();
		await runtime.session.setModel(model);
		if (!isCommandScopeActive(this.host, scope)) return;
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Selected model ${ref}` });
		if (runtime.session.isStreaming) {
			this.host.addEntry({
				id: createId("system"),
				kind: "system",
				text: "Skipped reload because the agent is still running. Run /reload when idle to refresh model-specific tools.",
			});
			this.host.toast.warning("Model changed; reload skipped while the agent is running");
			this.host.setSessionStatus(runtime.session);
			return;
		}

		await this.reloadAfterModelChange(runtime.session, ref, scope);
		if (!isCommandScopeActive(this.host, scope)) return;
		this.host.setSessionStatus(runtime.session);
	}

	async runThinkingCommand(level: ThinkingLevel): Promise<void> {
		const runtime = getRuntime(this.host, "thinking");
		if (!runtime) return;

		this.host.setStatus(`selecting thinking ${level}`);
		this.host.render();
		runtime.session.setThinkingLevel(level);
		this.addPersistentSystemEntry(runtime.session, `Selected thinking level ${runtime.session.thinkingLevel}`);
		this.host.setSessionStatus(runtime.session);
	}

	private addPersistentSystemEntry(session: AgentSession, text: string): void {
		appendPixSystemDisplayEntry(session, text);
		this.host.addEntry({ id: createId("system"), kind: "system", text });
	}

	private async reloadAfterModelChange(session: AgentSession, ref: string, scope: CommandScope): Promise<void> {
		this.host.setStatus(`reloading resources for ${ref}`);
		this.host.render();
		try {
			await session.reload();
			if (!isCommandScopeActive(this.host, scope)) return;
			this.host.addEntry({
				id: createId("system"),
				kind: "system",
				text: `Reloaded resources after model change to ${ref}`,
			});
			this.host.toast.success("Model changed and resources reloaded");
		} catch (error) {
			if (!isCommandScopeActive(this.host, scope)) return;
			this.host.addEntry({
				id: createId("error"),
				kind: "error",
				text: `Model changed to ${ref}, but reload failed: ${error instanceof Error ? error.message : String(error)}`,
			});
			this.host.toast.error("Model changed, but reload failed");
		}
	}

	private saveDefaultModel(modelRef: string): void {
		const saved = savePixDefaultModel(modelRef);
		if (!saved) throw new Error("Model must use provider/model[:thinking] format");

		this.host.addEntry({
			id: createId("system"),
			kind: "system",
			text: `Default model set to ${formatDefaultModelRef(saved)}. New sessions will use it unless --model is provided.`,
		});
	}

	private saveDefaultThinking(level: ThinkingLevel): void {
		const runtime = getRuntime(this.host, "default-thinking");
		if (!runtime) return;

		const fallbackModelRef = runtime.session.model ? this.host.modelRef(runtime.session.model as SessionModel) : undefined;
		const saved = savePixDefaultThinking(level, fallbackModelRef);
		if (!saved) throw new Error("Set /default-model first or select a session model before setting default thinking");

		this.host.addEntry({
			id: createId("system"),
			kind: "system",
			text: `Default thinking level set to ${saved.thinking ?? level} for ${saved.modelRef}. New sessions will use it unless --model is provided.`,
		});
		this.host.setSessionStatus(runtime.session);
	}
}

function formatDefaultModelRef(defaultModel: { modelRef: string; thinking?: ThinkingLevel }): string {
	return defaultModel.thinking ? `${defaultModel.modelRef}:${defaultModel.thinking}` : defaultModel.modelRef;
}
