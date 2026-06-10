import type {
	AgentSession,
	ExtensionUIContext,
	SessionManager,
	SessionInfo,
	SlashCommandSource,
	SourceInfo,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "../input-editor.js";
import type { SyntaxLineHighlight } from "../syntax-highlight.js";
import type { ThemeName } from "../theme.js";
import type { ToastKind, ToastNotifier } from "../ui.js";
import type { RenderedLink } from "./screen/file-links.js";
import type { WorkspaceMutation } from "./workspace/workspace-undo.js";
import type {
	SUBAGENT_ACTIVE_STATUSES,
	SUBAGENT_RENDER_MODES,
	SUBAGENT_STATUSES,
	SUBAGENT_TERMINAL_STATUSES,
	THINKING_LEVELS,
	TODO_ACTIONS,
	TODO_STATUSES,
} from "./constants.js";

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type NativeModifierKey = "shift" | "command" | "control" | "option";
export type SessionActivity = "idle" | "running" | "thinking";
export type SessionTabStatus = "active" | "waiting";
export type SessionTabAttention = "terminal-bell";
export type QueuedMessageMode = "steering" | "follow-up";
export type QueuedMessageSource = "sdk-steering" | "sdk-follow-up" | "deferred";

export type SubmittedUserMessage = {
	id: string;
	promptText: string;
	displayText: string;
	images: ImageContent[];
};

export type AppOptions = {
	cwd: string;
	themeName: ThemeName;
	sessionPath?: string;
	modelRef?: string;
	noSession: boolean;
};

export type Entry =
	| { id: string; kind: "system"; text: string }
	| {
			id: string;
			kind: "user";
			text: string;
			sessionEntryId?: string;
			workspaceMutations?: WorkspaceMutation[];
			images?: ImageContent[];
	  }
	| { id: string; kind: "queued"; mode: QueuedMessageMode; text: string; queueSource: QueuedMessageSource; queueIndex: number }
	| { id: string; kind: "assistant"; text: string }
	| { id: string; kind: "custom"; customType: string; text: string }
	| { id: string; kind: "session-aborted"; text: string }
	| {
			id: string;
			kind: "shell";
			command: string;
			output: string;
			expanded: boolean;
			status: "running" | "done";
			exitCode?: number | null;
			signal?: NodeJS.Signals | null;
			error?: string;
	  }
	| { id: string; kind: "thinking"; text: string; expanded: boolean; status: "running" | "done" }
	| {
			id: string;
			kind: "tool";
			toolCallId: string;
			toolName: string;
			argsText: string;
			output: string;
			images?: ImageContent[];
			details?: unknown;
			expanded: boolean;
			isError: boolean;
			status: "running" | "done";
		}
	| { id: string; kind: "error"; text: string };

export type TodoAction = (typeof TODO_ACTIONS)[number];
export type TodoStatus = (typeof TODO_STATUSES)[number];

export type TodoTask = {
	id: number;
	subject: string;
	status: TodoStatus;
	description?: string;
	activeForm?: string;
	thinking?: ThinkingLevel;
	parentId?: number;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
};

export type TodoTaskLinePart = {
	text: string;
	muted?: boolean;
	thinking?: ThinkingLevel;
};

export type TodoTaskRow = {
	task: TodoTask;
	depth: number;
};

export type TodoDetails = {
	action: TodoAction;
	params: Record<string, unknown>;
	tasks: TodoTask[];
	nextId: number;
	error?: string;
};

export type TodoLiveStateEvent = {
	version: 1;
	details: TodoDetails;
	sessionFile?: string;
	checkedAt: number;
};

export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];
export type SubagentActiveStatus = (typeof SUBAGENT_ACTIVE_STATUSES)[number];
export type SubagentTerminalStatus = (typeof SUBAGENT_TERMINAL_STATUSES)[number];
export type SubagentRenderMode = (typeof SUBAGENT_RENDER_MODES)[number];

export type SubagentAgentState = {
	id: string;
	status: SubagentStatus;
	exitCode?: number;
	startedAt?: string;
	finishedAt?: string;
	nextRetryAt?: string;
	pid?: number;
	resultLines?: number;
	stderrLines?: number;
	eventLines?: number;
	retryCount?: number;
};

export type SubagentTaskPreview = {
	id: string;
	task?: string;
	scope?: string;
	model?: string;
	thinking?: string;
	thinkingLevel?: string;
};

export type SubagentRunRenderDetails = {
	runDir: string;
	agents: SubagentAgentState[];
	tasks?: SubagentTaskPreview[];
	mode?: SubagentRenderMode;
	agentId?: string;
	state?: SubagentAgentState;
};

export type SubagentLiveStateRun = {
	runDir: string;
	agents: SubagentAgentState[];
	tasks?: SubagentTaskPreview[];
};

export type SubagentsLiveStateEvent = {
	version: 1;
	count: number;
	runs: SubagentLiveStateRun[];
	sessionFile?: string;
	checkedAt: number;
};

export type SubagentRegistry = {
	version: 1;
	latestRunId?: string;
	latestRunDir?: string;
	runs: Record<string, SubagentRegistryRun>;
	agents: Record<string, SubagentRegistryAgent>;
};

export type SubagentRegistryRun = {
	runId: string;
	runDir: string;
	agentIds: string[];
	createdAt: string;
	updatedAt: string;
};

export type SubagentRegistryAgent = {
	agentId: string;
	runId: string;
	runDir: string;
	updatedAt: string;
};

export type SubagentsWidgetState = {
	runDir: string;
	agents: SubagentAgentState[];
	tasks?: SubagentTaskPreview[];
	live: boolean;
	snapshotOnly: boolean;
	checkedAt: number;
};

export type RenderedLine = {
	text: string;
	copyText?: string;
	continuesOnNextLine?: boolean;
	variant?: "normal" | "muted" | "error" | "accent";
	colorOverride?: string;
	backgroundOverride?: string;
	segments?: readonly StyledSegment[];
	links?: readonly RenderedLink[];
	imageTargets?: readonly ImageClickTarget[];
	syntaxHighlight?: SyntaxLineHighlight | undefined;
	target?: { kind: "tool"; id: string } | { kind: "popup-menu"; index: number } | { kind: "popup-menu-close" } | { kind: "todo-panel" } | { kind: "subagents-panel" } | { kind: "user-message"; id: string } | { kind: "queue-message"; id: string } | ToastLineTarget;
};

export type ToastLineTarget = {
	kind: "toast";
	id: number;
	action?: "toast" | "body" | "close";
	startColumn?: number;
	endColumn?: number;
};

export type ImageClickTarget = {
	start: number;
	end: number;
	entryId: string;
	imageIndex: number;
};

export type ConversationBlockCache = {
	version: number;
	lines: readonly RenderedLine[];
	lineCount: number;
};

export type StyledSegment = {
	start: number;
	end: number;
	foreground?: string;
	background?: string;
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
};

export type StatusLineLayout = {
	details: string;
	text: string;
	sessionLabel: string;
	workspaceLabel: string;
	inputBorderWidgetStartColumn?: number;
	modelUsageLabel?: string;
	contextBarLabel?: string;
	userJumpWidget?: StatusUserJumpWidgetLayout;
	draftQueueWidget?: StatusDraftQueueWidgetLayout;
	thinkingExpandWidget?: StatusThinkingExpandWidgetLayout;
	compactToolsWidget?: StatusCompactToolsWidgetLayout;
	terminalBellSoundWidget?: StatusTerminalBellSoundWidgetLayout;
	promptEnhancerWidget?: StatusPromptEnhancerWidgetLayout;
	voiceWidget?: StatusVoiceWidgetLayout;
};

export type StatusUserJumpWidgetLayout = {
	startColumn: number;
	endColumn: number;
};

export type StatusDraftQueueWidgetLayout = {
	startColumn: number;
	endColumn: number;
};

export type StatusThinkingExpandWidgetLayout = {
	startColumn: number;
	endColumn: number;
};

export type StatusCompactToolsWidgetLayout = {
	startColumn: number;
	endColumn: number;
};

export type StatusTerminalBellSoundWidgetLayout = {
	startColumn: number;
	endColumn: number;
};

export type StatusPromptEnhancerWidgetLayout = {
	startColumn: number;
	endColumn: number;
};

export type StatusTerminalBellSoundTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type StatusVoiceWidgetLayout = {
	startColumn: number;
	micEndColumn: number;
	languageStartColumn: number;
	languageEndColumn: number;
	endColumn: number;
};

export type SessionTab = {
	id: string;
	title: string;
	titlePlaceholder?: "loading" | "new";
	status: SessionTabStatus;
	activity?: SessionActivity;
	attention?: SessionTabAttention;
	attentionVisible?: boolean;
	sessionPath?: string;
};

export type TabLineTarget = {
	kind: "close";
	tabId: string;
	startColumn: number;
	endColumn: number;
} | {
	kind: "tab";
	tabId: string;
	active: boolean;
	startColumn: number;
	endColumn: number;
} | {
	kind: "new-tab";
	startColumn: number;
	endColumn: number;
};

export type TabLineMouseTarget = TabLineTarget & {
	row: number;
};

export type TabLineLayout = {
	text: string;
	segments: readonly StyledSegment[];
	targets: readonly TabLineTarget[];
	separatorColumns: readonly number[];
};

export type ToolStatusEntry = {
	toolName: string;
	status: "running" | "done";
	isError: boolean;
	output: string;
};

export type RenderedInput = {
	lines: readonly string[];
	cursorRowOffset: number;
	cursorColumn: number;
	cursorVisible: boolean;
	scrollOffset: number;
	totalLineCount: number;
	visibleRowCount: number;
	scrollBar?: ScrollBarMetrics | undefined;
	editorStartRowOffset: number;
	tagSpans: readonly (readonly { start: number; end: number }[])[];
	suggestionSpans: readonly (readonly { start: number; end: number }[])[];
};

export type ScrollBarMetrics = {
	top: number;
	height: number;
	trackHeight: number;
};

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export type PixMenuVariant = "normal" | "accent" | "muted" | "error";

export type PixMenuItem<T = string> = {
	value: T;
	label: string;
	description?: string;
	keywords?: readonly string[];
	labelHighlightRanges?: readonly { start: number; end: number }[];
	descriptionHighlightRanges?: readonly { start: number; end: number }[];
	variant?: PixMenuVariant;
};

export type PixMenuOptions = {
	title: string;
	placeholder?: string;
	emptyText?: string;
	searchable?: boolean;
	minScorePerCharacter?: number;
	preferKeyboardLayoutMatches?: boolean;
	preserveStatus?: boolean;
};

export type PixMenuSelectOptions = Omit<PixMenuOptions, "title">;

export type PixMenuController = {
	show<T>(items: readonly PixMenuItem<T>[], options: PixMenuOptions): Promise<T | undefined>;
	select(title: string, options: readonly string[], menuOptions?: PixMenuSelectOptions): Promise<string | undefined>;
	close(): void;
};

export type AboveInputRenderer = {
	set(key: string, content: ExtensionWidgetContent): void;
	clear(key: string): void;
};

export type PixExtensionUIContext = Omit<ExtensionUIContext, "notify"> & {
	notify(message: string, type?: ToastKind): void;
	toast: ToastNotifier;
	aboveInput: AboveInputRenderer;
	renderAboveInput(key: string, content: ExtensionWidgetContent): void;
	showMenu<T>(items: readonly PixMenuItem<T>[], options: PixMenuOptions): Promise<T | undefined>;
	menu: PixMenuController;
};

export type WidgetTuiHandle = {
	requestRender(force?: boolean): void;
	showToast(message: string, kind?: ToastKind): void;
	toast: ToastNotifier;
	showMenu<T>(items: readonly PixMenuItem<T>[], options: PixMenuOptions): Promise<T | undefined>;
	menu: PixMenuController;
	pix?: {
		delegatedEditorInput?: boolean;
		inputMouse?: boolean;
	};
};

export type ExtensionWidgetTheme = ExtensionUIContext["theme"];

export type ExtensionWidgetComponent = {
	render(width: number): string[];
	invalidate?(): void;
	dispose?(): void;
};

export type ExtensionWidgetFactory = (tui: WidgetTuiHandle, theme: ExtensionWidgetTheme) => ExtensionWidgetComponent;

export type ExtensionWidgetContent = readonly string[] | ExtensionWidgetFactory;

export type ExtensionWidgetRegistration = {
	key: string;
	placement: WidgetPlacement;
	content: ExtensionWidgetContent;
	component?: ExtensionWidgetComponent;
};

export type EditorLayout = {
	renderedInput: RenderedInput;
	aboveEditorLines: readonly RenderedLine[];
	belowEditorLines: readonly RenderedLine[];
	inputStartRow: number;
	inputSeparatorRow: number;
	inputBottomSeparatorRow?: number;
	bodyHeight: number;
};

export type MouseEvent = {
	button: number;
	x: number;
	y: number;
	released: boolean;
};

export type ExtensionInputMouseEvent = MouseEvent & {
	localRow: number;
	localColumn: number;
	width: number;
};

export type ScreenPoint = {
	x: number;
	y: number;
};

export type ConversationSelectionPoint = {
	line: number;
	x: number;
};

export type MouseSelection = {
	anchor: ScreenPoint;
	current: ScreenPoint;
	moved: boolean;
	kind?: "screen" | "conversation";
	screenAnchor?: ScreenPoint;
	screenCurrent?: ScreenPoint;
	conversationAnchor?: ConversationSelectionPoint;
	conversationCurrent?: ConversationSelectionPoint;
};

export type NativeModifiersHelper = {
	isModifierPressed: (key: NativeModifierKey) => boolean;
};

export type SlashCommand = {
	name: string;
	description: string;
	kind: "builtin" | "resource";
	source?: SlashCommandSource;
	sourceInfo?: SourceInfo;
	keywords?: readonly string[];
	allowArguments?: boolean;
	suppressCommandEcho?: boolean;
	run?: (argumentsText: string) => Promise<void>;
};

export type SessionModel = NonNullable<AgentSession["model"]>;
export type SessionTreeNode = ReturnType<SessionManager["getTree"]>[number];

export type ModelMenuValue = {
	model: SessionModel;
	ref: string;
	current: boolean;
};

export type ScopedSessionModel = {
	model: SessionModel;
	thinkingLevel?: ThinkingLevel;
};

export type ThinkingMenuValue = {
	level: ThinkingLevel;
	current: boolean;
};

export type UserMessageMenuValue = "copy" | "fork" | "fork-new-tab" | "undo";
export type UserMessageJumpMenuValue = { entryId?: string; sessionEntryId?: string; text?: string; userIndex?: number; userCount?: number };
export type QueueMessageMenuValue = "cancel" | "edit" | "send-now";
export type ResumeMenuValue = { kind: "new" } | { kind: "session"; session: SessionInfo };

export type ActivePopupMenu = "slash" | "model" | "thinking" | "resume" | "user-message" | "user-message-jump" | "queue-message" | "sdk-menu";
export type PopupMenuPlacement = "default" | "under-tabs";

export type StatusThinkingTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type StatusModelTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type StatusSessionTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type StatusContextTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type StatusModelUsageTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type StatusVoiceMicTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type StatusVoiceLanguageTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type StatusPromptEnhancerTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type StatusUserJumpTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type StatusDraftQueueTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type StatusThinkingExpandTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type StatusCompactToolsTarget = {
	row: number;
	startColumn: number;
	endColumn: number;
};

export type ParsedSlashInput = {
	commandName: string;
	hasArguments: boolean;
	arguments: string;
};
