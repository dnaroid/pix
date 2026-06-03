import type { CommandControllerHost } from "./command-host.js";
import { ModelCommandActions } from "./command-model-actions.js";
import { NavigationCommandActions } from "./command-navigation-actions.js";
import { createSlashCommands, type CommandRegistryActions } from "./command-registry.js";
import { SessionCommandActions } from "./command-session-actions.js";
import type { PopupMenuPlacement, SessionModel, SlashCommand, ThinkingLevel } from "../types.js";

export class AppCommandController {
	readonly slashCommands: readonly SlashCommand[];

	private readonly modelActions: ModelCommandActions;
	private readonly sessionActions: SessionCommandActions;
	private readonly navigationActions: NavigationCommandActions;

	constructor(private readonly host: CommandControllerHost) {
		this.modelActions = new ModelCommandActions(host);
		this.sessionActions = new SessionCommandActions(host);
		this.navigationActions = new NavigationCommandActions(host);
		this.slashCommands = createSlashCommands(this.registryActions(), host);
	}

	async runResumeCommand(queryOrOptions: string | { preserveStatus?: boolean; placement?: PopupMenuPlacement } = ""): Promise<void> {
		await this.navigationActions.runResumeCommand(queryOrOptions);
	}

	async runModelCommand(model: SessionModel): Promise<void> {
		await this.modelActions.runModelCommand(model);
	}

	async runThinkingCommand(level: ThinkingLevel): Promise<void> {
		await this.modelActions.runThinkingCommand(level);
	}

	private registryActions(): CommandRegistryActions {
		return {
			runSettingsCommand: () => this.modelActions.runSettingsCommand(),
			runModelSlashCommand: (argumentsText) => this.modelActions.runModelSlashCommand(argumentsText),
			runDefaultModelSlashCommand: (argumentsText) => this.modelActions.runDefaultModelSlashCommand(argumentsText),
			runAutocompleteSlashCommand: (argumentsText) => this.modelActions.runAutocompleteSlashCommand(argumentsText),
			runScopedModelsCommand: (argumentsText) => this.modelActions.runScopedModelsCommand(argumentsText),
			runThinkingSlashCommand: (argumentsText) => this.modelActions.runThinkingSlashCommand(argumentsText),
			runDefaultThinkingSlashCommand: (argumentsText) => this.modelActions.runDefaultThinkingSlashCommand(argumentsText),
			runEnhanceCommand: () => this.host.enhancePrompt(),
			runExportCommand: (argumentsText) => this.sessionActions.runExportCommand(argumentsText),
			runImportCommand: (argumentsText) => this.sessionActions.runImportCommand(argumentsText),
			runShareCommand: () => this.sessionActions.runShareCommand(),
			runCopyCommand: () => this.sessionActions.runCopyCommand(),
			runQueueCommand: (argumentsText) => this.sessionActions.runQueueCommand(argumentsText),
			runNameCommand: (argumentsText) => this.sessionActions.runNameCommand(argumentsText),
			runSessionInfoCommand: () => this.sessionActions.runSessionInfoCommand(),
			runUsageCommand: () => this.sessionActions.runUsageCommand(),
			runChangelogCommand: () => this.sessionActions.runChangelogCommand(),
			runUpdateCommand: (argumentsText) => this.sessionActions.runUpdateCommand(argumentsText),
			runHotkeysCommand: () => this.sessionActions.runHotkeysCommand(),
			runReloadCommand: () => this.sessionActions.runReloadCommand(),
			runNewSessionCommand: () => this.sessionActions.runNewSessionCommand(),
			runNewTabCommand: () => this.host.openNewTab(),
			runCompactCommand: (customInstructions) => this.sessionActions.runCompactCommand(customInstructions),
			runForkCommand: (argumentsText) => this.navigationActions.runForkCommand(argumentsText),
			runCloneCommand: () => this.navigationActions.runCloneCommand(),
			runTreeCommand: (argumentsText) => this.navigationActions.runTreeCommand(argumentsText),
			runJumpCommand: (argumentsText) => this.navigationActions.runJumpCommand(argumentsText),
			runSearchCommand: (argumentsText) => this.navigationActions.runSearchCommand(argumentsText),
			runUnsupportedBuiltinCommand: (commandName, message) => this.navigationActions.runUnsupportedBuiltinCommand(commandName, message),
			runResumePathCommand: (sessionPath) => this.navigationActions.runResumePathCommand(sessionPath),
			runResumeCommand: () => this.navigationActions.runResumeCommand(),
		};
	}
}

export type { CommandControllerHost } from "./command-host.js";
