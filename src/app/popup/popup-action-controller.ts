import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { AppCommandController } from "../commands/command-controller.js";
import { createId } from "../id.js";
import type { AppMenuItemsController } from "./menu-items-controller.js";
import { stringifyUnknown } from "../rendering/message-content.js";
import type { AppPopupMenuController } from "./popup-menu-controller.js";
import type { AppQueuedMessageController } from "../session/queued-message-controller.js";
import type { Entry, SessionModel, SlashCommand, UserMessageJumpMenuValue } from "../types.js";
import type { AppWorkspaceActionsController } from "../workspace/workspace-actions-controller.js";

export type AppPopupActionControllerHost = {
	runtime(): AgentSessionRuntime | undefined;
	inputScopeKey?(): string | undefined;
	isDraftTabActive?(): boolean;
	materializeDraftSession?(): Promise<AgentSessionRuntime | undefined>;
	awaitCurrentSessionExtensions(runtime?: AgentSessionRuntime): Promise<void>;
	getBuiltinSlashCommands(): readonly SlashCommand[];
	isRunning(): boolean;
	setInput(value: string): void;
	addEntry(entry: Entry): void;
	setStatus(status: string): void;
	setSessionStatus(session: AgentSession | undefined): void;
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	visibleModels(): readonly string[] | undefined;
	saveVisibleModels(modelRefs: readonly string[]): readonly string[];
	render(): void;
	afterSessionReplacement(message?: string): void;
	openSessionInActiveDraftTab?(sessionPath: string): Promise<boolean>;
	scrollToConversationEntry(entryId: string): boolean;
	scrollToUserMessageJumpTarget(target: UserMessageJumpMenuValue): Promise<boolean>;
};

export class AppPopupActionController {
	constructor(
		private readonly host: AppPopupActionControllerHost,
		private readonly popupMenus: AppPopupMenuController,
		private readonly commandController: AppCommandController,
		private readonly menuItems: AppMenuItemsController,
		private readonly queuedMessages: AppQueuedMessageController,
		private readonly workspaceActions: AppWorkspaceActionsController,
	) {}

	async submitActivePopupMenu(): Promise<boolean> {
		const active = this.popupMenus.syncActivePopupMenu();
		if (!active) return false;

		if (active === "queue-message") return await this.submitSelectedQueueMessageAction();
		if (active === "user-message") return await this.submitSelectedUserMessageAction();
		if (active === "user-message-jump") return await this.submitSelectedUserMessageJump();
		if (active === "resume") return await this.submitSelectedResume();
		if (active === "model") return await this.submitSelectedModel();
		if (active === "sdk-menu") return this.popupMenus.submitSelectedSdkMenu();
		if (active === "slash") return await this.submitSelectedSlashCommand();
		return false;
	}

	async submitSlashCommand(text: string): Promise<void> {
		let scope = this.captureScope();
		const parsed = this.menuItems.parseSlashInput(text);
		if (!parsed) return;

		if (parsed.commandName.length === 0) {
			this.host.setStatus("type a slash command");
			this.host.render();
			return;
		}

		const builtinCommandName = parsed.commandName.toLowerCase();
		const command = this.host.getBuiltinSlashCommands().find((candidate) => candidate.name === builtinCommandName)
			?? this.menuItems.getResourceSlashCommands().find((candidate) => candidate.name === parsed.commandName);
		if (!command) {
			const suggestions = this.menuItems.getSlashCommandMatches(parsed.commandName, 3).map((match) => `/${match.value.name}`);
			this.host.showToast(suggestions.length > 0 ? `Unknown command /${parsed.commandName}; try ${suggestions.join(", ")}` : "Unknown command", "warning");
			this.host.render();
			return;
		}

		if (parsed.hasArguments && !command.allowArguments) {
			this.host.showToast(`/${command.name} does not take arguments`, "warning");
			this.host.render();
			return;
		}
		if (command.kind === "resource" && !scope.runtime && this.host.isDraftTabActive?.()) {
			const runtime = await this.host.materializeDraftSession?.();
			if (!runtime || (this.host.inputScopeKey && this.host.inputScopeKey() !== scope.inputScopeKey)) return;
			scope = this.captureScope();
		}

		this.host.setInput("");
		if (!command.suppressCommandEcho) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: `command: ${this.formatSlashCommandLine(command.name, parsed.arguments)}` });
		}
		this.host.render();

		try {
			if (command.kind === "resource") {
				await this.executeResourceSlashCommand(command, parsed.arguments, scope.session);
			} else {
				if (!command.run) throw new Error(`/${command.name} is not executable`);
				await command.run(parsed.arguments);
			}
		} catch (error) {
			if (!this.isScopeActive(scope)) return;
			this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
			this.host.showToast(`/${command.name} failed`, "error");
			this.host.setSessionStatus(this.host.runtime()?.session);
		}

		if (this.isScopeActive(scope)) this.host.render();
	}

	private async submitSelectedSlashCommand(): Promise<boolean> {
		const selected = this.popupMenus.selectedSlashCommand();
		if (!selected) return false;

		this.popupMenus.closeSlashCommandSelection();
		if (selected.name === "resume") {
			this.host.setInput("");
			await this.commandController.runResumeCommand();
			return true;
		}

		await this.submitSlashCommand(`/${selected.name}`);
		return true;
	}

	private async submitSelectedModel(): Promise<boolean> {
		if (this.popupMenus.modelVisibilityModeActive()) return this.toggleSelectedModelVisibility();
		const scope = this.captureScope();
		const selected = this.popupMenus.selectedModelThinking();
		if (!selected) return false;

		this.popupMenus.closeModelSelection();
		if (!selected.direct) {
			this.host.setInput("");
			this.host.addEntry({
				id: createId("system"),
				kind: "system",
				text: `command: /model ${selected.value.ref}:${selected.thinkingLevel}`,
			});
		}
		this.host.render();

		try {
			await this.commandController.runModelThinkingCommand(selected.value.model, selected.thinkingLevel);
		} catch (error) {
			if (!this.isScopeActive(scope)) return true;
			this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
			this.host.showToast("Model selection failed", "error");
			this.host.setSessionStatus(this.host.runtime()?.session);
		}

		if (this.isScopeActive(scope)) this.host.render();
		return true;
	}

	private toggleSelectedModelVisibility(): boolean {
		const selected = this.popupMenus.selectedModel();
		if (!selected) return false;
		if (selected.value.current) {
			this.host.showToast("The current model must remain visible", "warning");
			return true;
		}

		const allAvailableRefs = this.menuItems.getModelMenuItems("", true).map((item) => item.value.ref);
		const configured = this.host.visibleModels();
		const visible = new Set(configured === undefined ? allAvailableRefs : configured);
		const wasVisible = visible.has(selected.value.ref);
		if (wasVisible) visible.delete(selected.value.ref);
		else visible.add(selected.value.ref);
		const currentModel = this.host.runtime()?.session.model as SessionModel | undefined;
		if (currentModel) visible.add(this.menuItems.modelRef(currentModel));

		try {
			this.host.saveVisibleModels([...visible]);
			this.host.showToast(`${selected.value.ref} ${wasVisible ? "hidden from" : "shown in"} model pickers`, "info");
		} catch (error) {
			this.host.showToast(`Failed to save model visibility: ${stringifyUnknown(error)}`, "error");
		}
		this.host.render();
		return true;
	}

	clearVisibleModels(): boolean {
		if (!this.popupMenus.modelVisibilityModeActive()) return false;
		try {
			this.host.saveVisibleModels([]);
			this.host.showToast("Cleared model picker visibility", "info");
		} catch (error) {
			this.host.showToast(`Failed to clear model visibility: ${stringifyUnknown(error)}`, "error");
		}
		this.host.render();
		return true;
	}

	private async submitSelectedUserMessageAction(): Promise<boolean> {
		const scope = this.captureScope();
		const selected = this.popupMenus.selectedUserMessageAction();
		if (!selected) return false;

		this.popupMenus.closeUserMessageMenu();
		this.host.render();

		try {
			if (selected.value === "copy") {
				await this.workspaceActions.copyUserMessage(selected.entryId);
				return true;
			}
			if (selected.value === "fork") {
				await this.workspaceActions.forkFromUserMessage(selected.entryId);
				return true;
			}
			if (selected.value === "fork-new-tab") {
				await this.workspaceActions.forkFromUserMessageInNewTab(selected.entryId);
				return true;
			}
			await this.workspaceActions.undoChangesFromUserMessage(selected.entryId);
			return true;
		} catch (error) {
			if (!this.isScopeActive(scope)) return true;
			this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
			this.host.showToast(`${selected.label} failed`, "error");
			this.host.setSessionStatus(this.host.runtime()?.session);
			return true;
		}
	}

	private async submitSelectedUserMessageJump(): Promise<boolean> {
		const scope = this.captureScope();
		const selected = this.popupMenus.selectedUserMessageJump();
		if (!selected) return false;

		this.popupMenus.closeUserMessageJumpMenu();
		const found = await this.host.scrollToUserMessageJumpTarget(selected);
		if (!this.isScopeActive(scope)) return true;
		if (!found) {
			this.host.showToast("User message not found", "error");
			this.host.setSessionStatus(this.host.runtime()?.session);
			return true;
		}

		this.host.showToast("Jumped to user message", "success");
		this.host.setSessionStatus(this.host.runtime()?.session);
		return true;
	}

	private async submitSelectedQueueMessageAction(): Promise<boolean> {
		const scope = this.captureScope();
		const selected = this.popupMenus.selectedQueueMessageAction();
		if (!selected) return false;

		this.popupMenus.closeQueueMessageMenu();
		this.host.render();

		try {
			if (selected.value === "cancel") {
				await this.queuedMessages.cancelQueuedMessage(selected.entryId);
				return true;
			}
			if (selected.value === "edit") {
				await this.queuedMessages.editQueuedMessage(selected.entryId);
				return true;
			}
			await this.queuedMessages.sendQueuedMessageImmediately(selected.entryId);
			return true;
		} catch (error) {
			if (!this.isScopeActive(scope)) return true;
			this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
			this.host.showToast(`${selected.label} failed`, "error");
			this.host.setSessionStatus(this.host.runtime()?.session);
			return true;
		}
	}

	private async submitSelectedResume(): Promise<boolean> {
		const selected = this.popupMenus.selectedResume();
		if (!selected) return false;
		const draftSelector = this.popupMenus.draftSessionSelectorActive();

		this.popupMenus.setDirectMenu(undefined);
		this.popupMenus.setDirectPreserveStatus(false);
		this.popupMenus.setDirectQuery("");
		this.popupMenus.closeResumeMenu();
		this.popupMenus.setResumeMenuMode("resume");

		if (draftSelector) {
			if (selected.kind !== "session") return true;
			await this.host.openSessionInActiveDraftTab?.(selected.session.path);
			return true;
		}

		if (selected.kind === "new") {
			await this.submitSlashCommand("/new");
			return true;
		}

		const runtime = this.getIdleRuntime("resume");
		if (!runtime) return true;
		const { session } = selected;

		this.host.addEntry({ id: createId("system"), kind: "system", text: `Resuming session ${session.id.slice(0, 8)}…` });
		this.host.setStatus("switching session");
		this.host.render();

		try {
			await this.host.awaitCurrentSessionExtensions(runtime);
			if (!this.isRuntimeActive(runtime)) return true;
			const result = await runtime.switchSession(session.path);
			if (!this.isRuntimeActive(runtime)) return true;
			if (result.cancelled) {
				this.host.addEntry({ id: createId("system"), kind: "system", text: "Resume cancelled." });
				this.host.setSessionStatus(runtime.session);
				this.host.render();
				return true;
			}

			const name = runtime.session.sessionName ?? session.id.slice(0, 8);
			this.host.afterSessionReplacement(`Resumed session "${name}"`);
	} catch (error) {
		if (!this.isRuntimeActive(runtime)) return true;
		this.host.addEntry({ id: createId("error"), kind: "error", text: `Resume failed: ${error instanceof Error ? error.message : String(error)}` });
		this.host.showToast("Failed to resume session", "error");
		this.host.setSessionStatus(runtime.session);
	}

		if (this.isRuntimeActive(runtime)) this.host.render();
		return true;
	}

	private formatSlashCommandLine(name: string, argumentsText: string): string {
		return `/${name}${argumentsText ? ` ${argumentsText}` : ""}`;
	}

	private async executeResourceSlashCommand(command: SlashCommand, argumentsText: string, session: AgentSession | undefined): Promise<void> {
		const promptText = this.formatSlashCommandLine(command.name, argumentsText);
		this.host.setStatus(`running /${command.name}`);
		await this.queuedMessages.submitUserMessage(this.queuedMessages.createSubmittedUserMessage(promptText, promptText, []), session);
	}

	private captureScope(): { runtime: AgentSessionRuntime | undefined; session: AgentSession | undefined; inputScopeKey: string | undefined } {
		const runtime = this.host.runtime();
		return { runtime, session: runtime?.session, inputScopeKey: this.host.inputScopeKey?.() };
	}

	private isScopeActive(scope: { runtime: AgentSessionRuntime | undefined; session: AgentSession | undefined; inputScopeKey: string | undefined }): boolean {
		return this.host.isRunning()
			&& this.host.runtime() === scope.runtime
			&& scope.runtime?.session === scope.session
			&& (this.host.inputScopeKey === undefined || this.host.inputScopeKey() === scope.inputScopeKey);
	}

	private isRuntimeActive(runtime: AgentSessionRuntime): boolean {
		return this.host.isRunning() && this.host.runtime() === runtime;
	}

	private getRuntime(commandName: string): AgentSessionRuntime | undefined {
		const runtime = this.host.runtime();
	if (!runtime) {
		this.host.addEntry({ id: createId("error"), kind: "error", text: "Runtime is not initialized" });
		this.host.showToast(`/${commandName} unavailable`, "error");
		return undefined;
	}

		return runtime;
	}

	private getIdleRuntime(commandName: string): AgentSessionRuntime | undefined {
		const runtime = this.getRuntime(commandName);
		if (!runtime) return undefined;

		if (runtime.session.isStreaming) {
			this.host.showToast(`/${commandName} is unavailable while the agent is running`, "warning");
			return undefined;
		}

		return runtime;
	}
}
