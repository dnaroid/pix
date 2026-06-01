import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { AppCommandController } from "./command-controller.js";
import { createId } from "./id.js";
import type { AppMenuItemsController } from "./menu-items-controller.js";
import { stringifyUnknown } from "./message-content.js";
import type { AppPopupMenuController } from "./popup-menu-controller.js";
import type { AppQueuedMessageController } from "./queued-message-controller.js";
import type { Entry, SlashCommand } from "./types.js";
import type { AppWorkspaceActionsController } from "./workspace-actions-controller.js";

export type AppPopupActionControllerHost = {
	runtime(): AgentSessionRuntime | undefined;
	getBuiltinSlashCommands(): readonly SlashCommand[];
	isRunning(): boolean;
	setInput(value: string): void;
	addEntry(entry: Entry): void;
	setStatus(status: string): void;
	setSessionStatus(session: AgentSession | undefined): void;
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	render(): void;
	resetSessionView(): void;
	bindCurrentSession(): Promise<void>;
	loadSessionHistory(): void;
	scrollToConversationEntry(entryId: string): boolean;
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
		if (active === "user-message-jump") return this.submitSelectedUserMessageJump();
		if (active === "resume") return await this.submitSelectedResume();
		if (active === "model") return await this.submitSelectedModel();
		if (active === "thinking") return await this.submitSelectedThinking();
		if (active === "sdk-menu") return this.popupMenus.submitSelectedSdkMenu();
		if (active === "slash") return await this.submitSelectedSlashCommand();
		return false;
	}

	async submitSlashCommand(text: string): Promise<void> {
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

		this.host.setInput("");
		if (!command.suppressCommandEcho) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: `command: ${this.formatSlashCommandLine(command.name, parsed.arguments)}` });
		}
		this.host.render();

		try {
			if (command.kind === "resource") {
				await this.executeResourceSlashCommand(command, parsed.arguments);
			} else {
				if (!command.run) throw new Error(`/${command.name} is not executable`);
				await command.run(parsed.arguments);
			}
		} catch (error) {
			this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
			this.host.showToast(`/${command.name} failed`, "error");
			this.host.setSessionStatus(this.host.runtime()?.session);
		}

		if (this.host.isRunning()) this.host.render();
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
		const selected = this.popupMenus.selectedModel();
		if (!selected) return false;

		this.popupMenus.closeModelSelection();
		if (!selected.direct) {
			this.host.setInput("");
			this.host.addEntry({ id: createId("system"), kind: "system", text: `command: /model ${selected.value.ref}` });
		}
		this.host.render();

		try {
			await this.commandController.runModelCommand(selected.value.model);
		} catch (error) {
			this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
			this.host.showToast("/model failed", "error");
			this.host.setSessionStatus(this.host.runtime()?.session);
		}

		if (this.host.isRunning()) this.host.render();
		return true;
	}

	private async submitSelectedThinking(): Promise<boolean> {
		const selected = this.popupMenus.selectedThinking();
		if (!selected) return false;

		this.popupMenus.closeThinkingSelection();
		if (!selected.direct) {
			this.host.setInput("");
			this.host.addEntry({ id: createId("system"), kind: "system", text: `command: /thinking ${selected.value.level}` });
		}
		this.host.render();

		try {
			await this.commandController.runThinkingCommand(selected.value.level);
		} catch (error) {
			this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
			this.host.showToast("/thinking failed", "error");
			this.host.setSessionStatus(this.host.runtime()?.session);
		}

		if (this.host.isRunning()) this.host.render();
		return true;
	}

	private async submitSelectedUserMessageAction(): Promise<boolean> {
		const selected = this.popupMenus.selectedUserMessageAction();
		if (!selected) return false;

		this.popupMenus.closeUserMessageMenu();
		this.host.render();

		try {
			if (selected.value === "copy") {
				this.workspaceActions.copyUserMessage(selected.entryId);
				return true;
			}
			if (selected.value === "fork") {
				await this.workspaceActions.forkFromUserMessage(selected.entryId);
				return true;
			}
			await this.workspaceActions.undoChangesFromUserMessage(selected.entryId);
			return true;
		} catch (error) {
			this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
			this.host.showToast(`${selected.label} failed`, "error");
			this.host.setSessionStatus(this.host.runtime()?.session);
			return true;
		}
	}

	private submitSelectedUserMessageJump(): boolean {
		const selected = this.popupMenus.selectedUserMessageJump();
		if (!selected) return false;

		const entryId = selected.entryId;
	this.popupMenus.closeUserMessageJumpMenu();
	if (!this.host.scrollToConversationEntry(entryId)) {
		this.host.showToast("User message not found", "error");
		this.host.setSessionStatus(this.host.runtime()?.session);
		return true;
	}

	this.host.showToast("Jumped to user message", "success");
	this.host.setSessionStatus(this.host.runtime()?.session);
	return true;
}

	private async submitSelectedQueueMessageAction(): Promise<boolean> {
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
			this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
			this.host.showToast(`${selected.label} failed`, "error");
			this.host.setSessionStatus(this.host.runtime()?.session);
			return true;
		}
	}

	private async submitSelectedResume(): Promise<boolean> {
		const selected = this.popupMenus.selectedResume();
		if (!selected) return false;

		this.popupMenus.setDirectMenu(undefined);
		this.popupMenus.setDirectPreserveStatus(false);
		this.popupMenus.setDirectQuery("");
		this.popupMenus.closeResumeMenu();

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
			const result = await runtime.switchSession(session.path);
			if (result.cancelled) {
				this.host.addEntry({ id: createId("system"), kind: "system", text: "Resume cancelled." });
				this.host.setSessionStatus(runtime.session);
				this.host.render();
				return true;
			}

			this.host.resetSessionView();
			await this.host.bindCurrentSession();
			this.host.loadSessionHistory();
			const name = runtime.session.sessionName ?? session.id.slice(0, 8);
			this.host.addEntry({ id: createId("system"), kind: "system", text: `Resumed session "${name}"` });
			this.host.setSessionStatus(runtime.session);
	} catch (error) {
		this.host.addEntry({ id: createId("error"), kind: "error", text: `Resume failed: ${error instanceof Error ? error.message : String(error)}` });
		this.host.showToast("Failed to resume session", "error");
		this.host.setSessionStatus(runtime.session);
	}

		if (this.host.isRunning()) this.host.render();
		return true;
	}

	private formatSlashCommandLine(name: string, argumentsText: string): string {
		return `/${name}${argumentsText ? ` ${argumentsText}` : ""}`;
	}

	private async executeResourceSlashCommand(command: SlashCommand, argumentsText: string): Promise<void> {
		const promptText = this.formatSlashCommandLine(command.name, argumentsText);
		this.host.setStatus(`running /${command.name}`);
		await this.queuedMessages.submitUserMessage(this.queuedMessages.createSubmittedUserMessage(promptText, promptText, []));
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
