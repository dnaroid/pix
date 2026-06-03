import { THEMES, type Theme } from "../theme.js";
import type { ToastKind, ToastNotifier, ToastVariant } from "../ui.js";
import { InputEditor } from "../input-editor.js";
import {
	compileOutputFilterPatterns,
	loadPixConfig,
	resolveToolRule,
	type PixConfig,
} from "../config.js";
import type {
	AppOptions,
	Entry,
	SessionActivity,
	SlashCommand,
} from "./types.js";
import { AppCommandController } from "./commands/command-controller.js";
import { ConversationViewport } from "./rendering/conversation-viewport.js";
import { EditorLayoutRenderer } from "./rendering/editor-layout-renderer.js";
import { AppExtensionActionsController } from "./extensions/extension-actions-controller.js";
import { ExtensionUiController } from "./extensions/extension-ui-controller.js";
import { AppInputActionController } from "./input/input-action-controller.js";
import { AppInputController } from "./input/input-controller.js";
import { AppBlinkController } from "./screen/blink-controller.js";
import { isRecord } from "./guards.js";
import { AppMenuItemsController } from "./popup/menu-items-controller.js";
import { AppMouseController } from "./screen/mouse-controller.js";
import { createId } from "./id.js";
import { NerdFontController } from "./terminal/nerd-font-controller.js";
import { AppPopupActionController } from "./popup/popup-action-controller.js";
import { AppPopupMenuController } from "./popup/popup-menu-controller.js";
import { PopupMenuRenderer } from "./rendering/popup-menu-renderer.js";
import { AppPromptEnhancerController } from "./input/prompt-enhancer-controller.js";
import { AppAutocompleteController } from "./input/autocomplete-controller.js";
import { AppQueuedMessageController } from "./session/queued-message-controller.js";
import { ConversationEntryStore } from "./session/conversation-entry-store.js";
import { AppRequestHistory } from "./session/request-history.js";
import {
	createConversationViewport,
	createEditorLayoutRenderer,
	createRenderController,
	createScrollController,
	createStatusLineRenderer,
	createTabLineRenderer,
} from "./app-rendering-factories.js";
import { AppRenderController, type AppRenderResult } from "./rendering/render-controller.js";
import { createPixRuntime } from "./runtime.js";
import { ScreenStyler } from "./screen/screen-styler.js";
import { AppScrollController } from "./screen/scroll-controller.js";
import { searchResultScrollNeedles, searchResultTargetEntry, type SessionSearchResult } from "./session/session-search.js";
import { AppSessionLifecycleController } from "./session/session-lifecycle-controller.js";
import { AppShellController } from "./commands/shell-controller.js";
import { runInteractiveShellCommand } from "./commands/shell-command.js";
import { AppSessionEventController } from "./session/session-event-controller.js";
import { AppStatusController } from "./screen/status-controller.js";
import { StatusLineRenderer } from "./rendering/status-line-renderer.js";
import { AppModelUsageController } from "./model/model-usage-controller.js";
import { AppWorkspaceActionsController } from "./workspace/workspace-actions-controller.js";
import { AppSubagentsWidgetController } from "./subagents/subagents-widget-controller.js";
import { AppTodoWidgetController } from "./todo/todo-widget-controller.js";
import { AppTabsController } from "./session/tabs-controller.js";
import { TabLineRenderer } from "./rendering/tab-line-renderer.js";
import { AppTerminalController } from "./terminal/terminal-controller.js";
import { TerminalBellSoundController } from "./terminal/terminal-bell-sound-controller.js";
import { AppToastController } from "./rendering/toast-controller.js";
import { checkPixUpdate, formatPixStartupUpdateDialog } from "./cli/update.js";
import { AppVoiceController } from "./input/voice-controller.js";
import { createIsolatedExtensionEventBus } from "./extensions/extension-event-bus.js";
import { setAppIconTheme } from "./icons.js";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type EventBus,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";

const TERMINAL_BELL_ATTENTION_EVENT = "pix:terminal-bell:attention";
const SUBAGENTS_LIVE_STATE_EVENT = "pi-tools-suite:async-subagents:live-state";
const TODO_STATE_EVENT = "pi-tools-suite:todo:state";
const COALESCED_RENDER_DELAY_MS = 16;

export class PiUiExtendApp {
	private readonly conversationEntries = new ConversationEntryStore({
		deleteConversationEntry: (entryId) => this.deleteConversationEntryFromViewport(entryId),
	});
	private readonly options: AppOptions;
	private readonly theme: Theme;
	private readonly blinkController: AppBlinkController;
	private readonly screenStyler: ScreenStyler;
	private readonly statusController: AppStatusController;
	private readonly statusLineRenderer: StatusLineRenderer;
	private readonly modelUsageController: AppModelUsageController;
	private readonly tabsController: AppTabsController;
	private readonly tabLineRenderer: TabLineRenderer;
	private readonly editorLayoutRenderer: EditorLayoutRenderer;
	private readonly renderController: AppRenderController;
	private readonly sessionLifecycle: AppSessionLifecycleController;
	private readonly conversationViewport: ConversationViewport;
	private readonly scrollController: AppScrollController;
	private readonly extensionUiController: ExtensionUiController;
	private readonly extensionActions: AppExtensionActionsController;
	private readonly pixConfig: PixConfig;
	private readonly outputFilters: readonly RegExp[];
	private readonly commandController: AppCommandController;
	private readonly inputActions: AppInputActionController;
	private readonly inputController: AppInputController;
	private readonly menuItems: AppMenuItemsController;
	private readonly subagentsWidgetController: AppSubagentsWidgetController;
	private readonly todoWidgetController: AppTodoWidgetController;
	private readonly terminalController: AppTerminalController;
	private readonly terminalBellSoundController: TerminalBellSoundController;
	private readonly toastController: AppToastController;
	private readonly nerdFontController: NerdFontController;
	private readonly popupActions: AppPopupActionController;
	private readonly promptEnhancer: AppPromptEnhancerController;
	private readonly autocompleteController: AppAutocompleteController;
	private readonly mouseController: AppMouseController;
	private readonly popupMenus: AppPopupMenuController;
	private readonly voiceController: AppVoiceController;
	private readonly sessionEvents: AppSessionEventController;
	private readonly shellController: AppShellController;
	private readonly queuedMessages: AppQueuedMessageController;
	private readonly workspaceActions: AppWorkspaceActionsController;
	private readonly slashCommands: readonly SlashCommand[];
	private readonly toastNotifier: ToastNotifier = {
		show: (message, kind = "info") => {
			this.showToast(message, kind);
		},
		success: (message) => {
			this.showToast(message, "success");
		},
		error: (message) => {
			this.showToast(message, "error");
		},
		warning: (message) => {
			this.showToast(message, "warning");
		},
		info: (message) => {
			this.showToast(message, "info");
		},
	};
	private readonly extensionShutdownHandler = (): void => {};
	private runtime: AgentSessionRuntime | undefined;
	private readonly inputEditor = new InputEditor();
	private readonly requestHistory: AppRequestHistory;
	/** Shortcut: get/set the editor text as a plain string. */
	private get input(): string { return this.inputEditor.text; }
	private set input(value: string) { this.inputEditor.setText(value); }
	private get entries(): readonly Entry[] { return this.conversationEntries.entries; }
	private running = false;
	private scheduledRenderTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly pendingRenderReasons = new Set<string>();
	private todoPanelExpanded = true;
	private subagentsPanelExpanded = true;
	private allThinkingExpanded = false;
	private superCompactTools = false;
	private voicePartialText: string | undefined;
	private resumeSessions: SessionInfo[] = [];
	private resumeLoading = false;

	constructor(options: AppOptions) {
		this.options = options;
		this.theme = THEMES[options.themeName];
		const app = this;
		this.blinkController = new AppBlinkController({
			requestRender: (reason) => this.requestRender(reason),
			renderStatusLine: () => this.renderStatusLine(),
		});
		this.screenStyler = new ScreenStyler({
			theme: this.theme,
			cwd: this.options.cwd,
			get mouseSelection() { return app.mouseController.mouseSelection; },
		});
		this.toastController = new AppToastController({
			requestRender: (reason) => this.requestRender(reason),
		});
		this.nerdFontController = new NerdFontController({
			showToast: (message, kind) => this.showToast(message, kind),
			requestRender: (reason) => this.requestRender(reason),
		});
		this.statusController = new AppStatusController({
			cwd: this.options.cwd,
			theme: this.theme,
			blinkController: this.blinkController,
			runtimeSession: () => this.runtime?.session,
			requestRender: (reason) => this.requestRender(reason),
		});
		this.modelUsageController = new AppModelUsageController({
			runtimeSession: () => this.runtime?.session,
			requestRender: (reason) => this.requestRender(reason),
		});
		this.tabsController = new AppTabsController({
			options: this.options,
			blinkController: this.blinkController,
			runtime: () => this.runtime,
			createRuntimeForNewSession: () => createPixRuntime(newTabRuntimeOptions(this.options), { eventBus: this.createExtensionEventBus() }),
			createRuntimeForSession: (sessionPath) => createPixRuntime({
				...this.options,
				noSession: false,
				sessionPath,
			}, { eventBus: this.createExtensionEventBus() }),
			activateRuntime: (runtime) => this.activateRuntime(runtime),
			disposeRuntime: (runtime) => this.terminalController.disposeRuntime(runtime),
			isRunning: () => this.running,
			setStatus: (status) => this.setStatus(status),
			setSessionStatus: (session) => this.setSessionStatus(session),
			setSessionActivity: (activity) => this.setSessionActivity(activity),
			resetSessionView: () => this.resetSessionView(),
			loadSessionHistory: () => this.loadSessionHistory(),
			loadSessionHistoryAsync: (options) => this.loadSessionHistoryAsync(options),
			syncUserSessionEntryMetadata: () => this.workspaceActions.syncUserSessionEntryMetadata(),
			captureInputState: () => ({ text: this.inputEditor.text, cursor: this.inputEditor.cursor }),
			restoreInputState: (state) => this.restoreTabInputState(state.text, state.cursor),
			captureDeferredUserMessages: () => this.queuedMessages.captureDeferredUserMessages(),
			restoreDeferredUserMessages: (messages) => this.queuedMessages.restoreDeferredUserMessages(messages),
			addEntry: (entry) => this.addEntry(entry),
			showToast: (message, kind) => this.showToast(message, kind),
			requestRender: (reason) => this.requestRender(reason),
		});
		this.pixConfig = loadPixConfig();
		setAppIconTheme(this.pixConfig.iconTheme.name);
		this.terminalBellSoundController = new TerminalBellSoundController();
		this.promptEnhancer = new AppPromptEnhancerController({
			runtime: () => this.runtime,
			inputEditor: () => this.inputEditor,
			activeInputTabId: () => this.tabsController.activeInputTabId(),
			inputStateForTab: (tabId) => this.tabsController.inputStateForTab(tabId),
			setInputStateForTab: (tabId, state) => this.tabsController.setInputStateForTab(tabId, state),
			promptEnhancerConfig: () => this.pixConfig.promptEnhancer,
			resetInputAfterProgrammaticEdit: () => this.resetInputAfterProgrammaticEdit(),
			setStatus: (status) => this.setStatus(status),
			setSessionStatus: (session) => this.setSessionStatus(session),
			setSessionActivity: (activity) => this.setSessionActivity(activity),
			toast: this.toastNotifier,
			requestRender: (reason) => this.requestRender(reason),
		});
		this.autocompleteController = new AppAutocompleteController({
			runtime: () => this.runtime,
			inputEditor: () => this.inputEditor,
			autocompleteConfig: () => this.pixConfig.autocomplete,
			isRunning: () => this.running,
			requestRender: (reason) => this.requestRender(reason),
		});
		this.voiceController = new AppVoiceController({
			insertTranscript: (text) => this.insertVoiceTranscript(text),
			setPartialTranscript: (text) => this.setVoicePartialTranscript(text),
			addSystemMessage: (message) => this.addVoiceSystemMessage(message),
			showToast: (message, kind) => this.showToast(message, kind),
			requestRender: (reason) => this.requestRender(reason),
		}, this.pixConfig.dictation);
		this.menuItems = new AppMenuItemsController({
			runtime: () => this.runtime,
			getBuiltinSlashCommands: () => this.slashCommands,
			getEntries: () => this.entries,
			getResumeSessions: () => this.resumeSessions,
		});
		const popupMenuRenderer = new PopupMenuRenderer({
			theme: this.theme,
			screenStyler: this.screenStyler,
			get entries() { return app.entries; },
			get session() { return app.runtime?.session; },
			get resumeLoading() { return app.resumeLoading; },
			get resumeSessionCount() { return app.resumeSessions.length; },
		});
		this.popupMenus = new AppPopupMenuController({
			get entries() { return app.entries; },
			get session() { return app.runtime?.session; },
			get resumeLoading() { return app.resumeLoading; },
			get resumeSessionCount() { return app.resumeSessions.length; },
			isRunning: () => this.running,
			getInput: () => this.input,
			setInput: (value) => this.setInput(value),
			parseSlashInput: (text) => this.menuItems.parseSlashInput(text),
			getSlashCommandMenuItems: (query) => this.menuItems.getSlashCommandMenuItems(query),
			getModelMenuItems: (query) => this.menuItems.getModelMenuItems(query),
			getThinkingMenuItems: (query) => this.menuItems.getThinkingMenuItems(query),
			getResumeMenuItems: (query, limit) => this.menuItems.getResumeMenuItems(query, limit),
			getUserMessageMenuItems: () => this.menuItems.getUserMessageMenuItems(),
			getUserMessageJumpMenuItems: (query) => this.menuItems.getUserMessageJumpMenuItems(query),
			getQueueMessageMenuItems: () => this.menuItems.getQueueMessageMenuItems(),
			hasUserEntry: (entryId) => Boolean(this.findUserEntry(entryId)),
			hasQueuedEntry: (entryId) => Boolean(this.queuedMessages.findQueuedEntry(entryId)),
			setStatus: (status) => this.setStatus(status),
			restoreSessionStatus: () => this.restoreSessionStatus(),
			requestRender: (reason) => this.requestRender(reason),
		}, popupMenuRenderer);
		this.statusLineRenderer = createStatusLineRenderer({
			theme: this.theme,
			screenStyler: this.screenStyler,
			modelColors: this.pixConfig.modelColors,
			runtimeSession: () => this.runtime?.session,
			statusController: this.statusController,
			modelUsageController: this.modelUsageController,
			promptEnhancer: this.promptEnhancer,
			terminalBellSoundController: this.terminalBellSoundController,
			voiceController: this.voiceController,
			inputEditor: this.inputEditor,
			popupMenus: this.popupMenus,
			allThinkingExpanded: () => this.allThinkingExpanded,
			superCompactTools: () => this.superCompactTools,
		});
		this.tabLineRenderer = createTabLineRenderer({
			theme: this.theme,
			screenStyler: this.screenStyler,
			tabsController: this.tabsController,
		});
		this.extensionUiController = new ExtensionUiController({
			theme: this.theme,
			isRunning: () => this.running,
			requestRender: (reason) => this.requestRender(reason),
			showToast: (message, kind) => this.showToast(message, kind),
			toastNotifier: this.toastNotifier,
			menuController: this.popupMenus.menuController,
			setStatus: (status) => this.setStatus(status),
			restoreSessionStatus: () => this.restoreSessionStatus(),
			setInput: (value) => this.setInput(value),
			getInput: () => this.input,
			get entries() { return app.entries; },
			touchConversationEntry: (entry) => this.touchEntry(entry),
		});
		this.extensionActions = new AppExtensionActionsController({
			isRunning: () => this.running,
			getInput: () => this.input,
			setInput: (value) => this.setInput(value),
			resetSessionView: () => this.resetSessionView(),
			loadSessionHistory: () => this.loadSessionHistory(),
			afterSessionReplacement: (message) => this.afterSessionReplacement(message),
			addEntry: (entry) => this.addEntry(entry),
			setStatus: (status) => this.setStatus(status),
			setSessionStatus: (session) => this.setSessionStatus(session),
			showToast: (message, kind) => this.showToast(message, kind),
			requestRender: (reason) => this.requestRender(reason),
		});
		this.subagentsWidgetController = new AppSubagentsWidgetController({
			cwd: this.options.cwd,
			sessionFile: () => this.runtime?.session.sessionFile,
			isRunning: () => this.running,
			requestRender: (reason) => this.requestRender(reason),
		});
		this.todoWidgetController = new AppTodoWidgetController({
			sessionFile: () => this.runtime?.session.sessionFile,
			isRunning: () => this.running,
			requestRender: (reason) => this.requestRender(reason),
		});
		this.workspaceActions = new AppWorkspaceActionsController({
			get entries() { return app.entries; },
			runtime: () => this.runtime,
			findUserEntry: (entryId) => this.findUserEntry(entryId),
			touchEntry: (entry) => this.touchEntry(entry),
			resetSessionView: () => this.resetSessionView(),
			loadSessionHistory: () => this.loadSessionHistory(),
			addEntry: (entry) => this.addEntry(entry),
			setInput: (value) => this.setInput(value),
			getInput: () => this.input,
			setStatus: (status) => this.setStatus(status),
			setSessionStatus: (session) => this.setSessionStatus(session),
			showToast: (message, kind) => this.showToast(message, kind),
			requestRender: (reason) => this.requestRender(reason),
			isRunning: () => this.running,
		});
		this.sessionEvents = new AppSessionEventController({
			get entries() { return app.entries; },
			runtime: () => this.runtime,
			isRunning: () => this.running,
			addConversationEntry: (entry) => this.conversationEntries.addEntry(entry),
			prependConversationEntries: (entries) => this.conversationEntries.prependEntries(entries),
			touchConversationEntry: (entry) => this.conversationEntries.touchEntry(entry),
			requestRender: (reason) => this.requestRender(reason),
			setStatus: (status) => this.setStatus(status),
			restoreSessionStatus: () => this.restoreSessionStatus(),
			setSessionStatus: (session) => this.setSessionStatus(session),
			setSessionActivity: (activity) => this.setSessionActivity(activity),
			updateQueuedMessageStatus: () => this.queuedMessages.updateQueuedMessageStatus(),
			prepareWorkspaceMutation: (toolName, args) => this.workspaceActions.prepareWorkspaceMutation(toolName, args),
			workspaceMutationFromToolExecution: (input) => this.workspaceActions.workspaceMutationFromToolExecution(input),
			recordWorkspaceMutationForUserEntry: (entryId, mutation) => this.workspaceActions.recordWorkspaceMutationForUserEntry(entryId, mutation),
			scheduleUserSessionEntryMetadataSync: () => this.workspaceActions.scheduleUserSessionEntryMetadataSync(),
			toolDefaultExpanded: (toolName) => this.toolDefaultExpanded(toolName),
			observeSubagentsToolResult: (toolName, details, options) => this.subagentsWidgetController.observeToolResult(toolName, details, options),
			observeTodoToolResult: (toolName, details, isError) => this.todoWidgetController.observeToolResult(toolName, details, isError),
			showToast: (message, kind) => this.showToast(message, kind),
		});
		this.queuedMessages = new AppQueuedMessageController({
			runtime: () => this.runtime,
			requireRuntime: () => this.requireRuntime(),
			visibleEntries: () => this.conversationViewport.entries(),
			isRunning: () => this.running,
			requestRender: (reason) => this.requestRender(reason),
			addEntry: (entry) => this.addEntry(entry),
			addSessionAbortedEntry: () => this.sessionEvents.addSessionAbortedEntry(),
			setStatus: (status) => this.setStatus(status),
			setSessionStatus: (session) => this.setSessionStatus(session),
			setSessionActivity: (activity) => this.setSessionActivity(activity),
			showToast: (message, kind) => this.showToast(message, kind),
			inputText: () => this.input,
			resetRequestHistoryNavigation: () => this.requestHistory.resetNavigation(),
			clearInput: () => this.inputEditor.clear(),
			setInput: (value) => this.inputEditor.setText(value),
			insertInput: (value) => this.inputEditor.insert(value),
			attachImage: (data, mimeType) => this.inputEditor.attachImage(data, mimeType),
			onDeferredUserMessagesChanged: () => this.tabsController.persistActiveDeferredUserMessages(),
		});
		this.editorLayoutRenderer = createEditorLayoutRenderer({
			theme: this.theme,
			inputEditor: this.inputEditor,
			extensionUiController: this.extensionUiController,
			todoWidgetController: this.todoWidgetController,
			subagentsWidgetController: this.subagentsWidgetController,
			todoPanelExpanded: () => this.todoPanelExpanded,
			subagentsPanelExpanded: () => this.subagentsPanelExpanded,
			voicePartialText: () => this.voicePartialText,
			autocompleteController: this.autocompleteController,
		});
		this.outputFilters = compileOutputFilterPatterns(this.pixConfig.outputFilters.patterns);
		this.conversationViewport = createConversationViewport({
			entries: () => this.entries,
			runtimeSession: () => this.runtime?.session,
			queuedMessages: this.queuedMessages,
			entryRenderVersions: () => this.conversationEntries.entryRenderVersions,
			superCompactTools: () => this.superCompactTools,
			allThinkingExpanded: () => this.allThinkingExpanded,
			cwd: this.options.cwd,
			theme: this.theme,
			pixConfig: this.pixConfig,
			outputFilters: this.outputFilters,
			popupMenus: this.popupMenus,
		});
		this.scrollController = createScrollController({
			conversationViewport: this.conversationViewport,
			editorLayoutRenderer: this.editorLayoutRenderer,
			terminalColumns: () => this.terminalColumns(),
			terminalRows: () => this.terminalRows(),
			tabsController: this.tabsController,
			loadOlderSessionHistory: () => this.loadOlderSessionHistory(),
			requestRender: (reason) => this.requestRender(reason),
		});
		this.commandController = new AppCommandController({
			options: this.options,
			runtime: () => this.runtime,
			getInput: () => this.input,
			setInput: (value) => this.setInput(value),
			promptEnhancerModelRef: () => this.pixConfig.promptEnhancer.modelRef,
			autocompleteModelRef: () => this.pixConfig.autocomplete.modelRef,
			setAutocompleteModelRef: (modelRef) => {
				this.pixConfig.autocomplete.modelRef = modelRef;
				this.autocompleteController.dispose();
			},
			enhancePrompt: () => this.promptEnhancer.enhancePrompt(),
			isRunning: () => this.running,
			stop: () => this.stop(),
			addEntry: (entry) => this.addEntry(entry),
			setStatus: (status) => this.setStatus(status),
			toast: this.toastNotifier,
			requestRender: (reason) => this.requestRender(reason),
			showMenu: (items, options) => this.popupMenus.menuController.show(items, options),
			getModelMenuItems: (query) => this.menuItems.getModelMenuItems(query),
			getThinkingMenuItems: (query) => this.menuItems.getThinkingMenuItems(query),
			modelRef: (model) => this.menuItems.modelRef(model),
			getFavoriteScopedModels: () => this.menuItems.getFavoriteScopedModels(),
			setSessionStatus: (session) => this.setSessionStatus(session),
			queueUserMessage: (text) => {
				this.queuedMessages.deferUserMessage(this.queuedMessages.createSubmittedUserMessage(text, text, []));
			},
			resetSessionView: () => this.resetSessionView(),
			loadSessionHistory: () => this.loadSessionHistory(),
			afterSessionReplacement: (message) => this.afterSessionReplacement(message),
			openDirectPopupMenu: (menu, options) => this.popupMenus.openDirectPopupMenu(menu, options),
			getDirectPopupMenu: () => this.popupMenus.directMenu,
			setDirectPopupMenu: (menu) => {
				this.popupMenus.setDirectMenu(menu);
			},
			setDirectPopupMenuPreserveStatus: (preserveStatus) => {
				this.popupMenus.setDirectPreserveStatus(preserveStatus);
			},
			getDirectPopupMenuQuery: () => this.popupMenus.directQuery,
			setDirectPopupMenuQuery: (query) => {
				this.popupMenus.setDirectQuery(query);
			},
			getResumeLoading: () => this.resumeLoading,
			getResumeSessions: () => this.resumeSessions,
			setResumeLoading: (loading) => {
				this.resumeLoading = loading;
			},
			setResumeSessions: (sessions) => {
				this.resumeSessions = sessions;
			},
			openResumeMenuWithQuery: (query) => {
				this.popupMenus.openResumeMenuWithQuery(query);
			},
			closeResumeMenu: () => this.popupMenus.closeResumeMenu(),
			openNewTab: () => this.tabsController.openNewTab(),
			openSearchResultInNewTab: (result) => this.openSearchResultInNewTab(result),
		});
		this.popupActions = new AppPopupActionController(
			{
				runtime: () => this.runtime,
				getBuiltinSlashCommands: () => this.slashCommands,
				isRunning: () => this.running,
				setInput: (value) => this.setInput(value),
				addEntry: (entry) => this.addEntry(entry),
				setStatus: (status) => this.setStatus(status),
				setSessionStatus: (session) => this.setSessionStatus(session),
				showToast: (message, kind) => this.showToast(message, kind),
				requestRender: (reason) => this.requestRender(reason),
				resetSessionView: () => this.resetSessionView(),
				bindCurrentSession: () => this.bindCurrentSession(),
				loadSessionHistory: () => this.loadSessionHistory(),
				scrollToConversationEntry: (entryId) => this.scrollController.scrollToConversationEntry(entryId),
			},
			this.popupMenus,
			this.commandController,
			this.menuItems,
			this.queuedMessages,
			this.workspaceActions,
		);
		this.mouseController = new AppMouseController(
			{
				terminalColumns: () => this.terminalColumns(),
				terminalRows: () => this.terminalRows(),
				tabPanelRows: (terminalRows) => this.tabsController.tabPanelRows(terminalRows),
				conversationViewport: () => this.conversationViewport,
				editorLayoutRenderer: () => this.editorLayoutRenderer,
				inputEditor: () => this.inputEditor,
				resetRequestHistoryNavigation: () => this.requestHistory.resetNavigation(),
				findEntry: (entryId) => this.findEntry(entryId),
				touchEntry: (entry) => this.touchEntry(entry),
				getTodoPanelExpanded: () => this.todoPanelExpanded,
				setTodoPanelExpanded: (expanded) => {
					this.todoPanelExpanded = expanded;
				},
				getSubagentsPanelExpanded: () => this.subagentsPanelExpanded,
				setSubagentsPanelExpanded: (expanded) => {
					this.subagentsPanelExpanded = expanded;
				},
				setStatus: (status) => this.setStatus(status),
				runtimeSession: () => this.runtime?.session,
				cwd: () => this.options.cwd,
				enhancePrompt: () => this.promptEnhancer.enhancePrompt(),
				openNewTab: () => {
					void this.tabsController.openNewTab();
				},
				toggleVoiceRecording: () => {
					void this.voiceController.toggleRecording();
				},
				toggleVoiceLanguage: () => {
					void this.voiceController.toggleLanguage();
				},
				switchToTab: (tabId) => {
					void this.tabsController.switchToTab(tabId);
				},
				closeTab: (tabId) => {
					void this.tabsController.closeTab(tabId);
				},
				toastEntry: (toastId) => this.toastController.toast.entry(toastId),
				showToast: (message, kind, options) => this.showToast(message, kind, options),
				dismissToast: (toastId) => this.toastController.dismissToast(toastId),
				refreshModelUsageStatus: () => this.refreshModelUsageStatusFromClick(),
				queueInputFromStatus: () => {
					void this.inputActions.queueInputFromEditor().catch((error) => {
						this.addEntry({ id: createId("error"), kind: "error", text: `Queue input failed: ${error instanceof Error ? error.message : String(error)}` });
						this.showToast("Queue input failed", "error");
						this.setSessionStatus(this.runtime?.session);
						this.render();
					});
				},
				toggleAllThinkingExpanded: () => {
					this.allThinkingExpanded = !this.allThinkingExpanded;
					this.render();
				},
				toggleSuperCompactTools: () => {
					this.toggleSuperCompactTools();
					this.render();
				},
				toggleTerminalBellSound: () => this.toggleTerminalBellSound(),
				handleExtensionInputMouse: (event) => this.extensionUiController.handleCustomUiMouse(event),
				requestRender: (reason) => this.requestRender(reason),
			},
			this.popupMenus,
			this.popupActions,
			this.scrollController,
			this.commandController,
		);
		this.renderController = createRenderController({
			theme: this.theme,
			screenStyler: this.screenStyler,
			editorLayoutRenderer: this.editorLayoutRenderer,
			scrollController: this.scrollController,
			popupMenus: this.popupMenus,
			mouseController: this.mouseController,
			statusLineRenderer: this.statusLineRenderer,
			tabLineRenderer: this.tabLineRenderer,
			toastController: this.toastController,
			voiceProgressOverlayText: () => this.voiceController.progressOverlayText(),
			isRunning: () => this.running && !this.terminalController.isSuspended(),
			terminalColumns: () => this.terminalColumns(),
			terminalRows: () => this.terminalRows(),
		});
		this.requestHistory = new AppRequestHistory({
			noSession: this.options.noSession,
			getInput: () => this.inputEditor.text,
			setInput: (value) => this.inputEditor.setText(value),
			resetInputMenuDismissals: () => this.popupMenus.resetInputMenuDismissals(),
			requestRender: (reason) => this.requestRender(reason),
		});
		this.shellController = new AppShellController({
			cwd: this.options.cwd,
			isRunning: () => this.running,
			addEntry: (entry) => this.addEntry(entry),
			touchEntry: (entry) => this.touchEntry(entry),
			setStatus: (status) => this.setStatus(status),
			setSessionActivity: (activity) => this.setSessionActivity(activity),
			restoreSessionStatus: () => this.restoreSessionStatus(),
			requestRender: (reason) => this.requestRender(reason),
		});
		this.inputActions = new AppInputActionController(
			{
				runtime: () => this.runtime,
				isRunning: () => this.running,
				isSessionSwitching: () => this.tabsController.isSwitching(),
				inputEditor: () => this.inputEditor,
				requestHistory: () => this.requestHistory,
				clearPersistedInputDraft: () => this.clearPersistedInputDraft(),
				setStatus: (status) => this.setStatus(status),
				setSessionStatus: (session) => this.setSessionStatus(session),
				setSessionActivity: (activity) => this.setSessionActivity(activity),
				addEntry: (entry) => this.addEntry(entry),
				addSessionAbortedEntry: () => this.sessionEvents.addSessionAbortedEntry(),
				showToast: (message, kind) => this.showToast(message, kind),
				stopVoiceInput: () => this.voiceController.stopRecording(),
				isShellCommandRunning: () => this.shellController.isRunning(),
				runChatShellCommand: (command) => this.shellController.run(command),
				sendShellInput: (text) => this.shellController.sendInput(text),
				interruptShellCommand: () => this.shellController.interrupt(),
				runInteractiveShellCommand: (command) => this.terminalController.runWithInteractiveTerminal(
					() => runInteractiveShellCommand(command, this.options.cwd),
				),
				stop: () => this.stop(),
				requestRender: (reason) => this.requestRender(reason),
			},
			this.popupMenus,
			this.popupActions,
			this.queuedMessages,
		);
		this.inputController = new AppInputController({
			inputEditor: this.inputEditor,
			cwd: this.options.cwd,
			handleExtensionTerminalInput: (data) => this.extensionUiController.handleTerminalInput(data),
			extensionInputUsesEditor: () => this.extensionUiController.activeCustomUiUsesEditor(),
			getInput: () => this.input,
			getDirectPopupMenu: () => this.popupMenus.directMenu,
			resetRequestHistoryNavigation: () => this.requestHistory.resetNavigation(),
			resetInputMenuDismissals: () => this.popupMenus.resetInputMenuDismissals(),
			requestRender: (reason) => this.requestRender(reason),
			moveActivePopupMenuSelection: (delta) => this.popupMenus.moveActivePopupMenuSelection(delta as -1 | 1),
			navigateRequestHistory: (delta) => this.requestHistory.navigate(delta as -1 | 1),
			scrollByLines: (delta) => this.scrollController.scrollByLines(delta),
			scrollByPage: (delta) => this.scrollController.scrollByPage(delta as -1 | 1),
			handleMouse: (event) => this.mouseController.handleMouse(event),
			handleEnter: () => this.inputActions.handleEnter(),
			handleInterrupt: () => this.inputActions.handleInterrupt(),
			handleEscape: () => this.inputActions.handleEscape(),
			handleDirectPopupInput: (char) => this.popupMenus.handleDirectPopupInput(char),
			autocompleteModel: () => this.popupMenus.autocompleteModel(),
			autocompleteThinking: () => this.popupMenus.autocompleteThinking(),
			acceptAutocompleteSuggestion: () => this.autocompleteController.acceptSuggestion(),
			autocompleteSlashCommand: () => this.popupMenus.autocompleteSlashCommand(),
			toggleVoiceRecording: () => {
				void this.voiceController.toggleRecording();
			},
			stop: () => this.stop(),
		});
		this.terminalController = new AppTerminalController({
			isRunning: () => this.running,
			setRunning: (running) => {
				this.running = running;
			},
			runtime: () => this.runtime,
			saveInputStateForQuit: () => this.tabsController.saveInputStateForQuit(),
			disposeInactiveRuntimesForQuit: () => this.tabsController.disposeInactiveRuntimes(
				(runtime) => this.terminalController.disposeRuntimeForQuit(runtime),
			),
			requestRender: (reason) => this.requestRender(reason),
			handleInputChunk: (chunk) => this.inputController.handleChunk(chunk),
			closeSdkMenuForStop: () => this.popupMenus.closeSdkMenu(undefined, { render: false, restoreStatus: false }),
			clearToastTimers: () => this.clearToastTimers(),
			stopBlinking: () => this.stopBlinking(),
			stopSubagentsPolling: () => this.subagentsWidgetController.stopPolling(),
			stopModelUsagePolling: () => this.modelUsageController.stopPolling(),
			stopVoiceInput: () => this.voiceController.dispose(),
			stopAutocomplete: () => this.autocompleteController.dispose(),
			stopShellCommand: () => this.shellController.dispose(),
			unsubscribeSession: () => {
				this.sessionLifecycle.unsubscribeSession();
			},
			clearExtensionWidgets: () => this.extensionUiController.clearWidgets(),
			resetRenderOutputBuffer: () => this.renderController.resetOutputBuffer(),
		});
		this.sessionLifecycle = new AppSessionLifecycleController({
			options: this.options,
			createRuntime: () => createPixRuntime(this.options, { eventBus: this.createExtensionEventBus() }),
			runtime: () => this.runtime,
			setRuntime: (runtime) => {
				this.runtime = runtime;
			},
			isRunning: () => this.running,
			setRunning: (running) => {
				this.running = running;
			},
			inputText: () => this.input,
			setInput: (value) => this.setInput(value),
			inputEditor: () => this.inputEditor,
			enableTerminal: () => this.terminalController.enableTerminal(),
			disposeRuntimeForQuit: (runtime) => this.terminalController.disposeRuntimeForQuit(runtime),
			loadRequestHistory: () => this.requestHistory.load(),
			startSubagentsPolling: () => this.subagentsWidgetController.startPolling(),
			closeSdkMenuForBind: () => this.popupMenus.closeSdkMenu(undefined, { render: false, restoreStatus: false }),
			clearExtensionWidgets: () => this.extensionUiController.clearWidgets(),
			createExtensionUIContext: () => this.extensionUiController.createExtensionUIContext(),
			extensionShutdownHandler: () => this.extensionShutdownHandler,
			createExtensionCommandContextActions: (runtime) => this.extensionActions.createCommandContextActions(runtime),
			handleExtensionError: (error) => this.extensionActions.handleExtensionError(error),
			handleSessionEvent: (event) => this.handleSessionEvent(event),
			addEntry: (entry) => this.addEntry(entry),
			setStatus: (status) => this.setStatus(status),
			showToast: (message, kind) => this.showToast(message, kind),
			setSessionStatus: (session) => this.setSessionStatus(session),
			setSessionActivity: (activity) => this.setSessionActivity(activity),
			sessionEventsReset: () => this.sessionEvents.reset(),
			clearEntries: () => this.conversationEntries.clear(),
			resetSubagentsWidget: () => this.subagentsWidgetController.reset(),
			resetTodoWidget: () => this.todoWidgetController.reset(),
			conversationViewportClear: () => this.conversationViewport.clear(),
			queuedMessagesReset: () => this.queuedMessages.reset(),
			resetConversationMenuState: () => this.popupMenus.resetConversationMenuState(),
			clearMouseRenderState: () => this.mouseController.clearRenderHitMap(),
			scrollReset: () => this.scrollController.reset(),
			loadSessionHistoryEntries: () => this.sessionEvents.loadSessionHistory(),
			loadSessionHistoryEntriesAsync: (options) => this.sessionEvents.loadSessionHistoryAsync(options),
			syncUserSessionEntryMetadata: () => this.workspaceActions.syncUserSessionEntryMetadata(),
			restoreTabsAfterStartup: () => this.tabsController.restoreAfterStartup(),
			requestRender: (reason) => this.requestRender(reason),
			renderImmediately: () => this.render(),
		});
		this.slashCommands = this.commandController.slashCommands;
	}

	async start(): Promise<void> {
		await this.sessionLifecycle.start();
		this.modelUsageController.startPolling();
		this.nerdFontController.ensureInstalledOnStartup();
		void this.checkPixUpdateOnStartup();
	}

	private async checkPixUpdateOnStartup(): Promise<void> {
		try {
			const result = await checkPixUpdate();
			if (result.status !== "newer") return;
			this.showToast(formatPixStartupUpdateDialog(result), "warning", { variant: "dialog" });
		} catch {
			// Startup update checks should never interrupt the TUI.
		}
	}

	private async bindCurrentSession(): Promise<void> {
		await this.sessionLifecycle.bindCurrentSession();
	}

	private async activateRuntime(runtime: AgentSessionRuntime): Promise<void> {
		this.runtime = runtime;
		runtime.setRebindSession(async () => {
			await this.bindCurrentSession();
		});
		await this.bindCurrentSession();
	}

	private createExtensionEventBus(): EventBus {
		return createIsolatedExtensionEventBus((channel, data) => {
			if (channel === TERMINAL_BELL_ATTENTION_EVENT) this.handleTerminalBellAttention(data);
			if (channel === SUBAGENTS_LIVE_STATE_EVENT) this.subagentsWidgetController.observeLiveState(data);
			if (channel === TODO_STATE_EVENT) this.todoWidgetController.observeLiveState(data);
		});
	}

	private handleTerminalBellAttention(data: unknown): void {
		const sessionFile = isRecord(data) && typeof data.sessionFile === "string" ? data.sessionFile : undefined;
		this.tabsController.markTerminalBellAttention(sessionFile);
	}

	private deleteConversationEntryFromViewport(entryId: string): void {
		this.conversationViewport?.deleteEntry(entryId);
	}

	private afterSessionReplacement(message?: string): void {
		this.sessionLifecycle.afterSessionReplacement(message);
	}

	private requireRuntime(): AgentSessionRuntime {
		return this.sessionLifecycle.requireRuntime();
	}

	private restoreSessionStatus(): void {
		if (this.runtime) this.setSessionStatus(this.runtime.session);
	}

	private setInput(value: string): void {
		if (value !== this.input) {
			this.requestHistory.resetNavigation();
			this.popupMenus.resetInputMenuDismissals();
		}
		this.input = value;
		this.autocompleteController.dispose();
	}

	private resetInputAfterProgrammaticEdit(): void {
		this.requestHistory.resetNavigation();
		this.popupMenus.resetInputMenuDismissals();
		this.autocompleteController.dispose();
	}

	private restoreTabInputState(text: string, cursor: number): void {
		this.requestHistory.resetNavigation();
		this.popupMenus.resetInputMenuDismissals();
		this.inputEditor.setText(text, cursor);
		this.autocompleteController.dispose();
	}

	private async clearPersistedInputDraft(): Promise<void> {
		await this.tabsController.setInputStateForTab(this.tabsController.activeInputTabId(), { text: "", cursor: 0 });
	}

	private insertVoiceTranscript(text: string): void {
		const transcript = text.trim().replace(/\s+/gu, " ");
		if (!transcript) return;

		const selection = this.inputEditor.selection;
		const start = selection ? Math.min(selection.anchor, selection.active) : this.inputEditor.cursor;
		const end = selection ? Math.max(selection.anchor, selection.active) : this.inputEditor.cursor;
		const before = this.inputEditor.text.slice(0, start);
		const after = this.inputEditor.text.slice(end);
		const prefix = before.length > 0 && !/\s$/u.test(before) ? " " : "";
		const suffix = after.length > 0 && !/^\s/u.test(after) ? " " : "";

		this.requestHistory.resetNavigation();
		this.popupMenus.resetInputMenuDismissals();
		this.inputEditor.insert(`${prefix}${transcript}${suffix}`);
		this.render();
	}

	private setVoicePartialTranscript(text: string | undefined): void {
		if (this.voicePartialText === text) return;
		this.voicePartialText = text;
		this.scheduleRender();
	}

	private addVoiceSystemMessage(message: string): void {
		this.addEntry({ id: createId("system"), kind: "system", text: message });
		this.render();
	}

	private resetSessionView(): void {
		this.sessionLifecycle.resetSessionView();
	}

	private loadSessionHistory(): void {
		this.sessionLifecycle.loadSessionHistory();
	}

	private async openSearchResultInNewTab(result: SessionSearchResult): Promise<void> {
		const opened = await this.tabsController.openSessionInNewTab(result.session.path);
		if (!opened) return;

		this.workspaceActions.syncUserSessionEntryMetadata();
		const target = searchResultTargetEntry(this.entries, result);
		if (!this.scrollController.scrollToConversationText({
			needles: searchResultScrollNeedles(result),
			...(target ? { entryId: target.id } : {}),
		})) {
			this.showToast("Opened session, but could not locate the match", "warning");
			this.setSessionStatus(this.runtime?.session);
			this.render();
			return;
		}

		this.showToast("Opened search result", "success");
		this.setSessionStatus(this.runtime?.session);
	}

	private async loadSessionHistoryAsync(options: { isCancelled: () => boolean; render: () => void }): Promise<boolean> {
		return this.sessionEvents.loadSessionHistoryAsync(options);
	}

	private async loadOlderSessionHistory(): Promise<void> {
		if (!this.sessionEvents.hasOlderSessionHistory()) return;
		await this.sessionEvents.loadOlderSessionHistory({
			isCancelled: () => !this.running,
			render: () => this.requestRender("session:older-history"),
		});
	}

	private handleSessionEvent(event: AgentSessionEvent): void {
		this.sessionEvents.handleSessionEvent(event);
	}

	private findEntry(id: string): Entry | undefined {
		return this.sessionEvents.findEntry(id);
	}

	private findUserEntry(id: string): Extract<Entry, { kind: "user" }> | undefined {
		return this.sessionEvents.findUserEntry(id);
	}

	private touchEntry(entry: Entry): void {
		this.sessionEvents.touchEntry(entry);
	}

	private addEntry(entry: Entry): void {
		this.sessionEvents.addEntry(entry);
	}

	private setStatus(status: string): void {
		this.statusController.setStatus(status);
	}

	private setSessionStatus(session: AgentSession | undefined): void {
		this.statusController.setSessionStatus(session);
		this.modelUsageController.observeSession(session);
		this.tabsController.syncActiveTabFromRuntime();
	}

	private setSessionActivity(activity: SessionActivity): void {
		this.statusController.setSessionActivity(activity);
	}

	private toolDefaultExpanded(toolName: string): boolean {
		if (this.superCompactTools) return false;
		return resolveToolRule(toolName, this.pixConfig.toolRenderer).defaultExpanded === true;
	}

	private toggleSuperCompactTools(): void {
		this.superCompactTools = !this.superCompactTools;
		for (const entry of this.entries) {
			if (entry.kind !== "tool") continue;

			const defaultExpanded = resolveToolRule(entry.toolName, this.pixConfig.toolRenderer).defaultExpanded === true;
			const nextExpanded = this.superCompactTools ? false : defaultExpanded;
			if (entry.expanded === nextExpanded) continue;

			entry.expanded = nextExpanded;
			this.touchEntry(entry);
		}
	}

	private stopBlinking(): void {
		this.blinkController.dispose();
	}

	private async stop(): Promise<void> {
		await this.terminalController.stop();
	}

	private toggleTerminalBellSound(): void {
		try {
			const enabled = this.terminalBellSoundController.toggle();
			this.showToast(enabled ? "Terminal bell notifications enabled" : "Terminal bell notifications muted", "info");
			this.render();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showToast(`Could not update terminal bell notifications: ${message}`, "error");
		}
	}

	private refreshModelUsageStatusFromClick(): void {
		const refresh = this.modelUsageController.refreshNow();
		if (refresh.kind === "unsupported") {
			this.showToast("Usage limits are unavailable for this model", "warning");
			return;
		}

		if (refresh.kind === "in-flight") {
			this.showToast("Usage limits refresh already in progress", "info");
			return;
		}

		this.showToast("Refreshing model usage limits…", "info");
		void refresh.promise.then((result) => {
			if (result === "refreshed") {
				this.showToast("Model usage limits refreshed", "success");
				return;
			}

			if (result === "unavailable") {
				this.showToast("Usage limits are unavailable for this model", "warning");
				return;
			}

			this.showToast("Failed to refresh model usage limits", "error");
		});
	}

	private showToast(message: string, kind: ToastKind = "info", options?: { durationMs?: number; variant?: ToastVariant }): void {
		this.toastController.showToast(message, kind, options);
	}

	private clearToastTimers(): void {
		this.toastController.clearToastTimers();
	}

	private requestRender(reason: string): void {
		this.pendingRenderReasons.add(reason);
		this.scheduleRender();
	}

	private render(): void {
		if (this.scheduledRenderTimer) {
			clearTimeout(this.scheduledRenderTimer);
			this.scheduledRenderTimer = undefined;
		}
		this.renderNow();
	}

	private renderNow(): void {
		this.pendingRenderReasons.clear();
		this.autocompleteController.observeInput();
		this.applyRenderResult(this.renderController.render());
	}

	private scheduleRender(): void {
		if (!this.running || this.scheduledRenderTimer) return;
		this.scheduledRenderTimer = setTimeout(() => {
			this.scheduledRenderTimer = undefined;
			this.renderNow();
		}, COALESCED_RENDER_DELAY_MS);
		this.scheduledRenderTimer.unref?.();
	}

	private renderStatusLine(): void {
		this.applyRenderResult(this.renderController.renderStatusLine());
	}

	private applyRenderResult(result: AppRenderResult | undefined): void {
		if (!result) return;
		if (result.kind === "full") {
			this.mouseController.applyRenderHitMap(result.hitMap);
			return;
		}
		this.mouseController.applyStatusRenderHitMap(result.hitMap);
	}

	private terminalColumns(): number {
		return Math.max(20, process.stdout.columns ?? 80);
	}

	private terminalRows(): number {
		return Math.max(8, process.stdout.rows ?? 24);
	}
}

function newTabRuntimeOptions(options: AppOptions): AppOptions {
	return {
		cwd: options.cwd,
		themeName: options.themeName,
		noSession: false,
		...(options.modelRef === undefined ? {} : { modelRef: options.modelRef }),
	};
}
