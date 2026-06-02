import { getIdleRuntime, getRuntime } from "./command-runtime.js";
import type { CommandControllerHost } from "./command-host.js";
import { createId } from "../id.js";
import { isThinkingLevel, parseScopedModelRef } from "../model/model-ref.js";
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
			`thinking: ${runtime.session.thinkingLevel}`,
			`theme: ${settings.getTheme() ?? this.host.options.themeName}`,
			`skill commands: ${settings.getEnableSkillCommands() ? "enabled" : "disabled"}`,
			`auto compaction: ${runtime.session.autoCompactionEnabled ? "enabled" : "disabled"}`,
			`steering mode: ${runtime.session.steeringMode}`,
			`follow-up mode: ${runtime.session.followUpMode}`,
			"scoped models:",
			scopedModelText,
			"",
			"Use /model, /thinking, /scoped-models, /export, /import, /reload for editable settings in pix.",
		].join("\n");
		this.host.addEntry({ id: createId("system"), kind: "system", text });
		this.host.setSessionStatus(runtime.session);
	}

	async runModelSlashCommand(argumentsText: string): Promise<void> {
		const modelRef = argumentsText.trim();
		if (!modelRef) {
			const selected = await this.host.showMenu(this.host.getModelMenuItems(""), {
				title: "Select model",
				placeholder: "Search models",
				emptyText: "No matching models",
			});
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

		runtime.services.modelRegistry.refresh();
		const model = runtime.services.modelRegistry.find(parsed.provider, parsed.modelId) as SessionModel | undefined;
		if (!model) throw new Error(`Model not found: ${parsed.provider}/${parsed.modelId}`);

		await this.runModelCommand(model);
		if (parsed.thinkingLevel !== undefined) {
			runtime.session.setThinkingLevel(parsed.thinkingLevel);
			this.host.addEntry({ id: createId("system"), kind: "system", text: `Selected thinking level ${runtime.session.thinkingLevel}` });
			this.host.setSessionStatus(runtime.session);
		}
	}

	async runScopedModelsCommand(argumentsText: string): Promise<void> {
		const runtime = getIdleRuntime(this.host, "scoped-models");
		if (!runtime) return;

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
		runtime.services.modelRegistry.refresh();
		for (const ref of refs) {
			const parsed = parseScopedModelRef(ref);
			const model = parsed ? runtime.services.modelRegistry.find(parsed.provider, parsed.modelId) as SessionModel | undefined : undefined;
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
		const level = argumentsText.trim();
		if (!level) {
			const selected = await this.host.showMenu(this.host.getThinkingMenuItems(""), {
				title: "Select thinking level",
				placeholder: "Search thinking levels",
				emptyText: "No matching thinking levels",
			});
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

	async runModelCommand(model: SessionModel): Promise<void> {
		const runtime = getRuntime(this.host, "model");
		if (!runtime) return;

		const ref = this.host.modelRef(model);
		this.host.setStatus(`selecting model ${ref}`);
		this.host.render();
		await runtime.session.setModel(model);
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Selected model ${ref}` });
		this.host.setSessionStatus(runtime.session);
	}

	async runThinkingCommand(level: ThinkingLevel): Promise<void> {
		const runtime = getRuntime(this.host, "thinking");
		if (!runtime) return;

		this.host.setStatus(`selecting thinking ${level}`);
		this.host.render();
		runtime.session.setThinkingLevel(level);
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Selected thinking level ${runtime.session.thinkingLevel}` });
		this.host.setSessionStatus(runtime.session);
	}
}
