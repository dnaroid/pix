import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

import {
	getPixConfigPath,
	getProjectPixConfigPath,
	savePixAutocompleteModel,
	savePixDefaultAutoModel,
	savePixDefaultModel,
	savePixDefaultThinking,
	savePixDictationLanguage,
	savePixVisibleModels,
	saveProjectPixIgnoreContextFiles,
	type PixConfig,
} from "../../config.js";
import type { WorkspaceToolSurface, WorkspaceToolSurfaceLine, WorkspaceToolSurfaceSnapshot } from "./workspace-tool-controller.js";

type EditKind = "model" | "autocomplete" | "visible-models" | "dictation-language" | "max-sessions" | "prompt-enhancer";
type EditState = { kind: EditKind; value: string };

export type SettingsSurfaceHost = {
	cwd: string;
	config(): PixConfig;
	onConfigChanged(): void;
	render(): void;
};

export class SettingsWorkspaceToolSurface implements WorkspaceToolSurface {
	readonly id = "settings" as const;
	private edit: EditState | undefined;
	private error: string | undefined;
	private notice: string | undefined;
	private toolsConfig: Record<string, unknown> = {};
	private loading = false;
	private saving = false;

	constructor(private readonly host: SettingsSurfaceHost) {}

	async open(): Promise<void> {
		await this.reloadToolsConfig();
	}

	close(): void {
		this.edit = undefined;
	}

	canClose(): boolean {
		return !this.loading && !this.saving;
	}

		snapshot(): WorkspaceToolSurfaceSnapshot {
		if (this.edit) return this.editSnapshot();
		const config = this.host.config();
		const lines: WorkspaceToolSurfaceLine[] = [
			{ text: "Pix", variant: "accent" },
			{ text: `Default model · ${config.modelRouting.default ? "Auto" : config.defaultModel?.modelRef ?? "not configured"}`, action: "setting-model", control: "button" },
			{ text: `Default thinking · ${config.defaultModel?.thinking ?? "provider default"}`, action: "setting-thinking", control: "button" },
			{ text: `Auto model routing · ${config.modelRouting.enabled ? (config.modelRouting.default ? "enabled · default" : "enabled") : "disabled"}`, action: "setting-routing", control: "button" },
			{ text: `Autocomplete · ${config.autocomplete.modelRef || "disabled"}`, action: "setting-autocomplete", control: "button" },
			{ text: `Prompt enhancer · ${config.promptEnhancer.modelRef || "disabled"}`, action: "setting-enhancer", control: "button" },
			{ text: `Visible models · ${config.visibleModels?.length ? config.visibleModels.join(", ") : "all"}`, action: "setting-visible-models", control: "button" },
			{ text: `Project context files · ${config.ignoreContextFiles ? "disabled" : "enabled"}`, action: "setting-context", control: "button" },
			{ text: `Icon theme · ${config.iconTheme.name}`, action: "setting-icons", control: "button" },
			{ text: `Dictation language · ${config.dictation.language || "default"}`, action: "setting-dictation", control: "button" },
			{ text: `Max project sessions · ${config.maxProjectSessions || "unlimited"}`, action: "setting-retention", control: "button" },
			{ text: "" },
			{ text: "pi-tools-suite", variant: "accent" },
			{ text: `Suite · ${toolsBoolean(this.toolsConfig.enabled, true) ? "enabled" : "disabled"}`, action: "setting-suite", control: "button" },
			{ text: `Todo thinking · ${toolsBoolean(this.toolsConfig.todoThinking, false) ? "enabled" : "disabled"}`, action: "setting-todo-thinking", control: "button" },
			{ text: `   Disabled modules: ${stringArray(this.toolsConfig.disabledModules).join(", ") || "none explicitly configured"}`, variant: "muted" },
			{ text: `   User config: ${getPixConfigPath()}`, variant: "muted" },
			{ text: `   Project config: ${getProjectPixConfigPath(this.host.cwd)}`, variant: "muted" },
			{ text: `   Tools config: ${toolsConfigPath()}`, variant: "muted" },
		];
		if (this.loading) lines.unshift({ text: "Reading settings…", variant: "muted" });
		if (this.notice) lines.push({ text: "", variant: "muted" }, { text: this.notice, variant: "accent" });
		if (this.error) lines.push({ text: "", variant: "muted" }, { text: this.error, variant: "error" });
		return {
			title: "Settings",
			subtitle: "TUI configuration",
			lines,
			footer: "Click a setting to edit or toggle it · mouse wheel scrolls · Esc closes",
		};
	}

		handleInput(data: string): boolean {
		if (this.loading || this.saving) return true;
		if (this.edit) return this.handleEditInput(data);
		const config = this.host.config();
		if (data === "m") return this.beginEdit("model", config.defaultModel?.modelRef ?? "");
		if (data === "a") return this.beginEdit("autocomplete", config.autocomplete.modelRef ?? "");
		if (data === "e") return this.beginEdit("prompt-enhancer", config.promptEnhancer.modelRef ?? "");
		if (data === "v") return this.beginEdit("visible-models", config.visibleModels?.join(", ") ?? "");
		if (data === "l") return this.beginEdit("dictation-language", config.dictation.language ?? "");
		if (data === "p") return this.beginEdit("max-sessions", String(config.maxProjectSessions));
		if (data === "t") {
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
			const current = config.defaultModel?.thinking ?? "medium";
			const next = levels[(Math.max(0, levels.indexOf(current as typeof levels[number])) + 1) % levels.length]!;
			if (!savePixDefaultThinking(next, config.defaultModel?.modelRef)) {
				this.error = "Set a default model before changing its default thinking level.";
				return true;
			}
			this.changed(`Default thinking set to ${next}.`);
			return true;
		}
		if (data === "c") {
			saveProjectPixIgnoreContextFiles(this.host.cwd, !config.ignoreContextFiles);
			this.changed(`Project context files ${config.ignoreContextFiles ? "enabled" : "disabled"}.`);
			return true;
		}
		if (data === "i") {
			void this.writePixValue(["iconTheme", "name"], config.iconTheme.name === "nerdFont" ? "fallback" : "nerdFont", "Icon theme updated.");
			return true;
		}
		if (data === "r") {
			if (!config.modelRouting.default) {
				savePixDefaultAutoModel();
				this.changed("Auto model routing enabled as the default.");
			} else {
				void this.writePixValue(["modelRouting", "default"], false, "Auto model routing is no longer the default.");
			}
			return true;
		}
		if (data === "P") {
			void this.writeToolsValue(["enabled"], !toolsBoolean(this.toolsConfig.enabled, true), "pi-tools-suite setting updated.");
			return true;
		}
		if (data === "T") {
			void this.writeToolsValue(["todoThinking"], !toolsBoolean(this.toolsConfig.todoThinking, false), "Todo thinking setting updated.");
			return true;
		}
		return false;
	}

	async activate(action: string): Promise<void> {
		if (this.loading || this.saving) return;
		if (this.edit) {
			if (action === "edit-cancel") {
				this.edit = undefined;
				return;
			}
			if (action === "edit-save") {
				const edit = this.edit;
				this.edit = undefined;
				await this.saveEdit(edit);
			}
			return;
		}
		const shortcut = settingShortcut(action);
		if (shortcut) this.handleInput(shortcut);
	}

	private editSnapshot(): WorkspaceToolSurfaceSnapshot {
		const edit = this.edit!;
		const label = editLabel(edit.kind);
		return {
			title: `Settings · ${label}`,
			lines: [
				{ text: `› ${label}: ${edit.value || "(empty)"}`, variant: "accent" },
				{ text: "Save", action: "edit-save", control: "button" },
				{ text: "Cancel", action: "edit-cancel", control: "button" },
			],
			footer: "Type the value, then click Save or Cancel",
		};
	}

	private beginEdit(kind: EditKind, value: string): true {
		this.edit = { kind, value };
		this.error = undefined;
		return true;
	}

	private handleEditInput(data: string): boolean {
		const edit = this.edit;
		if (!edit) return false;
		if (data === "\x1b") {
			this.edit = undefined;
			return true;
		}
		if (data === "\r" || data === "\n") {
			this.edit = undefined;
			void this.saveEdit(edit);
			return true;
		}
		if (data === "\u007f" || data === "\b") {
			edit.value = edit.value.slice(0, -1);
			return true;
		}
		if ([...data].every((char) => char >= " " && char !== "\u007f")) {
			edit.value = `${edit.value}${data}`.replace(/[\r\n]/gu, " ").slice(0, 4096);
			return true;
		}
		return true;
	}

	private async saveEdit(edit: EditState): Promise<void> {
		try {
			const value = edit.value.trim();
			if (edit.kind === "model") {
				if (!value || !savePixDefaultModel(value)) throw new Error("Model must use provider/model[:thinking] format.");
				this.changed("Default model updated.");
				return;
			}
			if (edit.kind === "autocomplete") {
				savePixAutocompleteModel(value);
				this.changed(value ? "Autocomplete model updated." : "Autocomplete disabled.");
				return;
			}
			if (edit.kind === "visible-models") {
				if (!value) {
					await this.writePixValue(["visibleModels"], undefined, "Visible model scope cleared; all models are visible.");
					return;
				}
				savePixVisibleModels(value.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean));
				this.changed("Visible model scope updated.");
				return;
			}
			if (edit.kind === "dictation-language") {
				if (!value) throw new Error("Dictation language cannot be empty.");
				savePixDictationLanguage(value);
				this.changed("Dictation language updated.");
				return;
			}
			if (edit.kind === "max-sessions") {
				const parsed = Number(value);
				if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) throw new Error("Max project sessions must be an integer from 0 to 10000.");
				await this.writePixValue(["maxProjectSessions"], parsed, "Session retention updated.");
				return;
			}
			if (!value) throw new Error("Prompt enhancer model cannot be empty.");
			await this.writePixValue(["promptEnhancer", "modelRef"], value, "Prompt enhancer model updated.");
		} catch (error) {
			this.error = errorMessage(error);
			this.host.render();
		}
	}

	private changed(message: string): void {
		this.error = undefined;
		this.notice = message;
		this.host.onConfigChanged();
		this.host.render();
	}

	private async writePixValue(path: readonly (string | number)[], value: unknown, notice: string): Promise<void> {
		this.saving = true;
		this.host.render();
		try {
			await updateJsoncFile(getPixConfigPath(), path, value);
			this.changed(notice);
		} catch (error) {
			this.error = errorMessage(error);
		} finally {
			this.saving = false;
			this.host.render();
		}
	}

	private async writeToolsValue(path: readonly (string | number)[], value: unknown, notice: string): Promise<void> {
		this.saving = true;
		this.host.render();
		try {
			await updateJsoncFile(toolsConfigPath(), path, value);
			await this.reloadToolsConfig();
			this.notice = notice;
		} catch (error) {
			this.error = errorMessage(error);
		} finally {
			this.saving = false;
			this.host.render();
		}
	}

	private async reloadToolsConfig(): Promise<void> {
		this.loading = true;
		this.error = undefined;
		this.host.render();
		try {
			this.toolsConfig = await readJsoncObject(toolsConfigPath());
		} catch (error) {
			this.error = errorMessage(error);
		} finally {
			this.loading = false;
			this.host.render();
		}
	}
}

async function updateJsoncFile(path: string, propertyPath: readonly (string | number)[], value: unknown): Promise<void> {
	let source = "{}\n";
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) throw error;
	}
	const edits = modify(source, [...propertyPath], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
	const updated = applyEdits(source, edits);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
}

async function readJsoncObject(path: string): Promise<Record<string, unknown>> {
	try {
		const parsed = parseJsonc(await readFile(path, "utf8")) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return {};
		throw error;
	}
}

function toolsConfigPath(): string {
	return join(process.env.PI_CONFIG_DIR?.trim() || join(homedir(), ".config", "pi"), "pi-tools-suite.jsonc");
}

function toolsBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function editLabel(kind: EditKind): string {
	if (kind === "model") return "Default model";
	if (kind === "autocomplete") return "Autocomplete model";
	if (kind === "visible-models") return "Visible models";
	if (kind === "dictation-language") return "Dictation language";
	if (kind === "max-sessions") return "Max project sessions";
	return "Prompt enhancer model";
}

function settingShortcut(action: string): string | undefined {
	if (action === "setting-model") return "m";
	if (action === "setting-thinking") return "t";
	if (action === "setting-routing") return "r";
	if (action === "setting-autocomplete") return "a";
	if (action === "setting-enhancer") return "e";
	if (action === "setting-visible-models") return "v";
	if (action === "setting-context") return "c";
	if (action === "setting-icons") return "i";
	if (action === "setting-dictation") return "l";
	if (action === "setting-retention") return "p";
	if (action === "setting-suite") return "P";
	if (action === "setting-todo-thinking") return "T";
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
