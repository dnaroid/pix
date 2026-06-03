import type { PixConfig } from "../config.js";
import type { InputEditor } from "../input-editor.js";
import type { Theme } from "../theme.js";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { AppAutocompleteController } from "./input/autocomplete-controller.js";
import type { AppPopupMenuController } from "./popup/popup-menu-controller.js";
import { ConversationViewport } from "./rendering/conversation-viewport.js";
import { EditorLayoutRenderer } from "./rendering/editor-layout-renderer.js";
import { AppRenderController } from "./rendering/render-controller.js";
import { StatusLineRenderer } from "./rendering/status-line-renderer.js";
import { TabLineRenderer } from "./rendering/tab-line-renderer.js";
import type { AppToastController } from "./rendering/toast-controller.js";
import type { AppMouseController } from "./screen/mouse-controller.js";
import { AppScrollController } from "./screen/scroll-controller.js";
import type { ScreenStyler } from "./screen/screen-styler.js";
import type { AppStatusController } from "./screen/status-controller.js";
import type { AppModelUsageController } from "./model/model-usage-controller.js";
import type { AppQueuedMessageController } from "./session/queued-message-controller.js";
import type { AppTabsController } from "./session/tabs-controller.js";
import type { AppSubagentsWidgetController } from "./subagents/subagents-widget-controller.js";
import type { TerminalBellSoundController } from "./terminal/terminal-bell-sound-controller.js";
import type { AppTodoWidgetController } from "./todo/todo-widget-controller.js";
import type { AppVoiceController } from "./input/voice-controller.js";
import type { AppPromptEnhancerController } from "./input/prompt-enhancer-controller.js";
import type { ExtensionUiController } from "./extensions/extension-ui-controller.js";
import type { Entry } from "./types.js";

type RuntimeSession = AgentSessionRuntime["session"] | undefined;

export type StatusLineRendererFactoryOptions = {
	theme: Theme;
	screenStyler: ScreenStyler;
	modelColors: PixConfig["modelColors"];
	runtimeSession: () => RuntimeSession;
	statusController: AppStatusController;
	modelUsageController: AppModelUsageController;
	promptEnhancer: AppPromptEnhancerController;
	terminalBellSoundController: TerminalBellSoundController;
	voiceController: AppVoiceController;
	inputEditor: InputEditor;
	popupMenus: AppPopupMenuController;
	allThinkingExpanded: () => boolean;
	superCompactTools: () => boolean;
};

export function createStatusLineRenderer(options: StatusLineRendererFactoryOptions): StatusLineRenderer {
	return new StatusLineRenderer({
		theme: options.theme,
		screenStyler: options.screenStyler,
		get session() { return options.runtimeSession(); },
		modelColors: options.modelColors,
		get sessionActivity() { return options.statusController.sessionActivity; },
		get statusDotBright() { return options.statusController.statusDotBright; },
		currentStatus: () => options.statusController.currentStatus(),
		statusWorkspaceLabel: () => options.statusController.statusWorkspaceLabel(),
		statusWorkspaceGitBranchLabel: () => options.statusController.statusWorkspaceGitBranchLabel(),
		statusModelLabel: (session) => options.statusController.statusModelLabel(session),
		statusThinkingLabel: (session) => options.statusController.statusThinkingLabel(session),
		formatContextUsagePercent: (session) => options.statusController.formatContextUsagePercent(session),
		roundedContextUsagePercent: (session) => options.statusController.roundedContextUsagePercent(session),
		contextUsagePercentColor: (percent) => options.statusController.contextUsagePercentColor(percent),
		modelUsageStatusLabel: () => options.modelUsageController.statusLabel(),
		promptEnhancerStatusWidgetText: () => options.promptEnhancer.statusWidgetText(),
		promptEnhancerStatusWidgetActive: () => options.promptEnhancer.statusWidgetActive(),
		promptEnhancerStatusWidgetEnabled: () => options.promptEnhancer.statusWidgetEnabled(),
		terminalBellSoundStatusWidgetText: () => options.terminalBellSoundController.statusWidgetText(),
		terminalBellSoundStatusWidgetEnabled: () => options.terminalBellSoundController.isEnabled(),
		voiceStatusWidgetText: () => options.voiceController.statusWidgetText(),
		voiceStatusWidgetActive: () => options.voiceController.statusWidgetActive(),
		queueableInputActive: () => options.inputEditor.promptText.trimEnd().length > 0 || options.inputEditor.images.length > 0,
		userMessageJumpMenuActive: () => options.popupMenus.directMenu === "user-message-jump",
		allThinkingExpandedActive: () => options.allThinkingExpanded(),
		superCompactToolsActive: () => options.superCompactTools(),
	});
}

export type TabLineRendererFactoryOptions = {
	theme: Theme;
	screenStyler: ScreenStyler;
	tabsController: AppTabsController;
};

export function createTabLineRenderer(options: TabLineRendererFactoryOptions): TabLineRenderer {
	return new TabLineRenderer({
		theme: options.theme,
		screenStyler: options.screenStyler,
		get tabs() { return options.tabsController.tabs(); },
	});
}

export type EditorLayoutRendererFactoryOptions = {
	theme: Theme;
	inputEditor: InputEditor;
	extensionUiController: ExtensionUiController;
	todoWidgetController: AppTodoWidgetController;
	subagentsWidgetController: AppSubagentsWidgetController;
	todoPanelExpanded: () => boolean;
	subagentsPanelExpanded: () => boolean;
	voicePartialText: () => string | undefined;
	autocompleteController: AppAutocompleteController;
};

export function createEditorLayoutRenderer(options: EditorLayoutRendererFactoryOptions): EditorLayoutRenderer {
	return new EditorLayoutRenderer({
		theme: options.theme,
		inputEditor: options.inputEditor,
		get extensionWidgets() { return options.extensionUiController.widgets; },
		get todoDetails() { return options.todoWidgetController.widgetDetails; },
		get todoPanelExpanded() { return options.todoPanelExpanded(); },
		get subagentsPanelExpanded() { return options.subagentsPanelExpanded(); },
		get subagentsWidgetState() { return options.subagentsWidgetController.widgetState; },
		get voicePartialText() { return options.voicePartialText(); },
		get autocompleteSuggestion() { return options.autocompleteController.suggestionText(); },
		renderExtensionInputComponent: (width) => options.extensionUiController.renderActiveCustomUi(width),
		extensionInputUsesEditor: () => options.extensionUiController.activeCustomUiUsesEditor(),
		widgetTuiHandle: () => options.extensionUiController.widgetTuiHandle(),
		createExtensionTheme: () => options.extensionUiController.createExtensionTheme(),
		suppressExtensionWidget: (key) => options.extensionUiController.suppressWidget(key),
	});
}

export type ConversationViewportFactoryOptions = {
	entries: () => readonly Entry[];
	runtimeSession: () => RuntimeSession;
	queuedMessages: AppQueuedMessageController;
	entryRenderVersions: () => ReadonlyMap<string, number>;
	superCompactTools: () => boolean;
	allThinkingExpanded: () => boolean;
	cwd: string;
	theme: Theme;
	pixConfig: PixConfig;
	outputFilters: readonly RegExp[];
	popupMenus: AppPopupMenuController;
};

export function createConversationViewport(options: ConversationViewportFactoryOptions): ConversationViewport {
	return new ConversationViewport({
		get entries() { return options.entries(); },
		get session() { return options.runtimeSession(); },
		get deferredUserMessages() { return options.queuedMessages.deferredUserMessages; },
		get entryRenderVersions() { return options.entryRenderVersions(); },
		get superCompactTools() { return options.superCompactTools(); },
		get allThinkingExpanded() { return options.allThinkingExpanded(); },
		cwd: options.cwd,
		colors: options.theme.colors,
		pixConfig: options.pixConfig,
		outputFilters: options.outputFilters,
		hasDynamicConversationBlock: () => options.popupMenus.hasDynamicConversationBlock(),
		isDynamicConversationBlock: (entry) => options.popupMenus.isDynamicConversationBlock(entry),
		renderInlineUserMessageMenu: (entry, context) => options.popupMenus.renderInlineUserMessageMenu(entry, context),
	});
}

export type ScrollControllerFactoryOptions = {
	conversationViewport: ConversationViewport;
	editorLayoutRenderer: EditorLayoutRenderer;
	terminalColumns: () => number;
	terminalRows: () => number;
	tabsController: AppTabsController;
	loadOlderSessionHistory: () => Promise<void>;
	requestRender: (reason: string) => void;
};

export function createScrollController(options: ScrollControllerFactoryOptions): AppScrollController {
	return new AppScrollController({
		conversationViewport: () => options.conversationViewport,
		editorLayoutRenderer: () => options.editorLayoutRenderer,
		terminalColumns: options.terminalColumns,
		terminalRows: options.terminalRows,
		tabPanelRows: (terminalRows) => options.tabsController.tabPanelRows(terminalRows),
		loadOlderSessionHistory: options.loadOlderSessionHistory,
		requestRender: options.requestRender,
	});
}

export type RenderControllerFactoryOptions = {
	theme: Theme;
	screenStyler: ScreenStyler;
	editorLayoutRenderer: EditorLayoutRenderer;
	scrollController: AppScrollController;
	popupMenus: AppPopupMenuController;
	mouseController: AppMouseController;
	statusLineRenderer: StatusLineRenderer;
	tabLineRenderer: TabLineRenderer;
	toastController: AppToastController;
	voiceProgressOverlayText: () => string | undefined;
	isRunning: () => boolean;
	terminalColumns: () => number;
	terminalRows: () => number;
};

export function createRenderController(options: RenderControllerFactoryOptions): AppRenderController {
	return new AppRenderController(
		{
			isRunning: options.isRunning,
			terminalColumns: options.terminalColumns,
			terminalRows: options.terminalRows,
		},
		{
			theme: options.theme,
			screenStyler: options.screenStyler,
			editorLayoutRenderer: options.editorLayoutRenderer,
			scrollController: options.scrollController,
			popupMenus: options.popupMenus,
			mouseController: options.mouseController,
			statusLineRenderer: options.statusLineRenderer,
			tabLineRenderer: options.tabLineRenderer,
			toastController: options.toastController,
			voiceProgressOverlayText: options.voiceProgressOverlayText,
		},
	);
}
