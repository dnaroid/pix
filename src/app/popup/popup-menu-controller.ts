import { resolve } from "node:path";
import { fuzzySearch, type FuzzySearchItem } from "../../fuzzy.js";
import { PopupMenu, type PopupMenuItem } from "../../ui.js";
import { sanitizeText } from "../rendering/render-text.js";
import {
	RESUME_MENU_INITIAL_SESSION_ROWS,
	RESUME_MENU_LOAD_BATCH_ROWS,
	RESUME_MENU_LOAD_THRESHOLD_ROWS,
	RESUME_MENU_MAX_ROWS,
	SLASH_COMMAND_MENU_MAX_ROWS,
	THINKING_LEVELS,
} from "../constants.js";
import type {
	ActivePopupMenu,
	Entry,
	ModelMenuValue,
	ModelThinkingMenuState,
	ParsedSlashInput,
	PixMenuController,
	PixMenuItem,
	PixMenuOptions,
	PixMenuSelectOptions,
	PopupMenuPlacement,
	QueueMessageMenuValue,
	RenderedLine,
	ResumeMenuValue,
	SlashCommand,
	ThinkingLevel,
	ThinkingMenuValue,
	UserMessageJumpMenuValue,
	UserMessageMenuValue,
} from "../types.js";
import type { AgentSession, SessionInfo } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

type SlashCommandMenuValue = SlashCommand;
type ModelPopupMenuValue = ModelMenuValue;
type ResumePopupMenuValue = ResumeMenuValue;
type UserMessagePopupMenuValue = UserMessageMenuValue;
type UserMessageJumpPopupMenuValue = UserMessageJumpMenuValue;
type QueueMessagePopupMenuValue = QueueMessageMenuValue;
type SdkPopupMenuValue = PixMenuItem<unknown>;

type SdkMenuRequest = {
	items: readonly PixMenuItem<unknown>[];
	options: PixMenuOptions;
	resolve: (value: unknown | undefined) => void;
};

type PopupMenuRendererPort = {
	popupMenuWidth(columns: number): number;
	popupMenuMargin(columns: number): number;
	effectivePopupMenuWidth(columns: number): number;
	styleOverlayLine(row: number, line: RenderedLine, width: number, activeMenu: PopupMenu<unknown>): string;
	overlayPlainText(line: RenderedLine, width: number): string;
	renderUserMessageMenu(width: number, menu: PopupMenu<UserMessagePopupMenuValue>): RenderedLine[];
	renderSlashCommandMenu(width: number, menu: PopupMenu<SlashCommandMenuValue>): RenderedLine[];
	renderModelMenu(width: number, menu: PopupMenu<ModelPopupMenuValue>, state: ModelThinkingMenuState): RenderedLine[];
	renderResumeMenu(
		width: number,
		menu: PopupMenu<ResumePopupMenuValue>,
		state: { directQuery: string; allSessionsLoaded: boolean; loadedSessionCount: number },
	): RenderedLine[];
	renderUserMessageJumpMenu(width: number, menu: PopupMenu<UserMessageJumpPopupMenuValue>, directQuery: string): RenderedLine[];
	renderQueueMessageMenu(width: number, menu: PopupMenu<QueueMessagePopupMenuValue>): RenderedLine[];
	renderSdkMenu(
		width: number,
		menu: PopupMenu<SdkPopupMenuValue>,
		request: { options: PixMenuOptions } | undefined,
		directQuery: string,
	): RenderedLine[];
};

export type DirectPopupMenu = Exclude<ActivePopupMenu, "slash">;

export type AppPopupMenuControllerHost = {
	readonly entries: readonly Entry[];
	readonly session: AgentSession | undefined;
	readonly resumeLoading: boolean;
	readonly resumeSessionCount: number;
	isRunning(): boolean;
	getInput(): string;
	setInput(value: string): void;
	parseSlashInput(text: string): ParsedSlashInput | undefined;
	getSlashCommandMenuItems(query: string): PopupMenuItem<SlashCommand>[];
	getModelMenuItems(query: string, includeHidden?: boolean): PopupMenuItem<ModelMenuValue>[];
	getThinkingMenuItems(query: string): PopupMenuItem<ThinkingMenuValue>[];
	getResumeMenuItems(query: string, limit?: number): PopupMenuItem<ResumeMenuValue>[];
	getUserMessageMenuItems(): PopupMenuItem<UserMessageMenuValue>[];
	getUserMessageJumpMenuItems(query: string): PopupMenuItem<UserMessageJumpMenuValue>[];
	getQueueMessageMenuItems(): PopupMenuItem<QueueMessageMenuValue>[];
	hasUserEntry(entryId: string): boolean;
	hasQueuedEntry(entryId: string): boolean;
	setStatus(status: string): void;
	restoreSessionStatus(): void;
	render(): void;
};

export class AppPopupMenuController {
	readonly menuController: PixMenuController = {
		show: <T,>(items: readonly PixMenuItem<T>[], options: PixMenuOptions) => this.showSdkMenu(items, options),
		select: (title, options, menuOptions) => this.selectSdkMenu(title, options, menuOptions),
		close: () => {
			this.closeSdkMenu(undefined);
		},
	};

	private readonly slashCommandMenu = new PopupMenu<SlashCommandMenuValue>({ maxVisibleRows: SLASH_COMMAND_MENU_MAX_ROWS });
	private readonly modelMenu = new PopupMenu<ModelPopupMenuValue>({ maxVisibleRows: SLASH_COMMAND_MENU_MAX_ROWS });
	private readonly resumeMenu = new PopupMenu<ResumePopupMenuValue>({ maxVisibleRows: RESUME_MENU_MAX_ROWS });
	private readonly userMessageMenu = new PopupMenu<UserMessagePopupMenuValue>({ maxVisibleRows: 4 });
	private readonly userMessageJumpMenu = new PopupMenu<UserMessageJumpPopupMenuValue>({ maxVisibleRows: RESUME_MENU_MAX_ROWS });
	private readonly queueMessageMenu = new PopupMenu<QueueMessagePopupMenuValue>({ maxVisibleRows: 4 });
	private readonly sdkMenu = new PopupMenu<SdkPopupMenuValue>({ maxVisibleRows: SLASH_COMMAND_MENU_MAX_ROWS });

	private sdkMenuRequest: SdkMenuRequest | undefined;
	private slashCommandMenuQuery = "";
	private dismissedSlashCommandMenuInput: string | undefined;
	private modelMenuQuery = "";
	private dismissedModelMenuInput: string | undefined;
	private modelThinkingInputQuery = "";
	private dismissedThinkingMenuInput: string | undefined;
	private modelThinkingLevel: ThinkingLevel | undefined;
	private modelThinkingSelectedRef: string | undefined;
	private modelThinkingSource: "model" | "thinking" = "model";
	private modelVisibilityMode = false;
	private directPopupMenu: DirectPopupMenu | undefined;
	private directPopupMenuPreserveStatus = false;
	private directPopupMenuPlacement: PopupMenuPlacement = "default";
	private directPopupMenuQuery = "";
	private resumeMenuQuery = "";
	private resumeMenuSessionLimit = RESUME_MENU_INITIAL_SESSION_ROWS;
	private resumeMenuAllSessionsLoaded = false;
	private activeUserMessageEntryId: string | undefined;
	private activeQueuedMessageEntryId: string | undefined;

	constructor(private readonly host: AppPopupMenuControllerHost, private readonly renderer: PopupMenuRendererPort) {}

	get directMenu(): DirectPopupMenu | undefined {
		return this.directPopupMenu;
	}

	get directQuery(): string {
		return this.directPopupMenuQuery;
	}

	setDirectMenu(menu: DirectPopupMenu | undefined): void {
		if (menu !== this.directPopupMenu && (
			menu === "model" || menu === "thinking" || this.directPopupMenu === "model" || this.directPopupMenu === "thinking"
		)) this.resetModelThinkingState();
		this.directPopupMenu = menu;
		if (!menu) this.directPopupMenuPlacement = "default";
	}

	setDirectPreserveStatus(preserveStatus: boolean): void {
		this.directPopupMenuPreserveStatus = preserveStatus;
	}

	setDirectQuery(query: string): void {
		this.directPopupMenuQuery = query;
		if (this.directPopupMenu === "resume") this.resetResumeMenuLazyState(query);
	}

	resetInputMenuDismissals(): void {
		this.dismissedSlashCommandMenuInput = undefined;
		this.dismissedModelMenuInput = undefined;
		this.dismissedThinkingMenuInput = undefined;
	}

	showSdkMenu<T>(items: readonly PixMenuItem<T>[], options: PixMenuOptions): Promise<T | undefined> {
		if (!this.host.isRunning()) return Promise.resolve(undefined);

		this.closeSdkMenu(undefined, { render: false, restoreStatus: false });
		const requestItems = items.map((item) => item as PixMenuItem<unknown>);

		return new Promise<T | undefined>((resolveResult) => {
			this.sdkMenuRequest = {
				items: requestItems,
				options,
				resolve: (value) => {
					resolveResult(value as T | undefined);
				},
			};
			this.openDirectPopupMenu(
				"sdk-menu",
				options.preserveStatus === undefined ? {} : { preserveStatus: options.preserveStatus },
			);
			this.host.render();
		});
	}

	selectSdkMenu(title: string, options: readonly string[], menuOptions: PixMenuSelectOptions = {}): Promise<string | undefined> {
		return this.showSdkMenu(
			options.map((option) => ({ value: option, label: option })),
			{ title, ...menuOptions },
		);
	}

	closeSdkMenu(value: unknown | undefined, options: { render?: boolean; restoreStatus?: boolean } = {}): void {
		const request = this.sdkMenuRequest;
		this.sdkMenuRequest = undefined;
		this.sdkMenu.close();
		if (this.directPopupMenu === "sdk-menu") {
			this.directPopupMenu = undefined;
			this.directPopupMenuPreserveStatus = false;
			this.directPopupMenuQuery = "";
		}
		if (request && options.restoreStatus !== false && request.options.preserveStatus !== true) this.host.restoreSessionStatus();
		request?.resolve(value);
		if (options.render !== false && this.host.isRunning()) this.host.render();
	}

	getActivePopupMenu(active: ActivePopupMenu): PopupMenu<unknown> {
		switch (active) {
			case "sdk-menu":
				return this.sdkMenu;
			case "queue-message":
				return this.queueMessageMenu;
			case "user-message-jump":
				return this.userMessageJumpMenu;
			case "user-message":
				return this.userMessageMenu;
			case "model":
				return this.modelMenu;
			case "thinking":
				return this.modelMenu;
			case "resume":
				return this.resumeMenu;
			case "slash":
				return this.slashCommandMenu;
		}
	}

	moveActivePopupMenuSelection(delta: number): boolean {
		const active = this.syncActivePopupMenu();
		if (!active) return false;

		this.getActivePopupMenu(active).moveSelection(delta);
		if (active === "model") this.syncModelThinkingToSelectedModel();
		this.host.render();
		return true;
	}

	moveActiveModelThinkingLevel(delta: number): boolean {
		if (this.syncActivePopupMenu() !== "model") return false;
		if (this.modelVisibilityMode) return true;
		const state = this.modelThinkingMenuState();
		const levels = state.availableThinkingLevels;
		if (levels.length === 0) return true;

		const currentIndex = Math.max(0, levels.indexOf(state.thinkingLevel));
		const nextIndex = (currentIndex + delta + levels.length) % levels.length;
		this.modelThinkingLevel = levels[nextIndex] ?? state.thinkingLevel;
		this.host.render();
		return true;
	}

	toggleModelVisibilityMode(): boolean {
		if (this.syncActivePopupMenu() !== "model") return false;
		this.modelVisibilityMode = !this.modelVisibilityMode;
		this.resetPopupMenuSelection(this.modelMenu);
		this.syncModelThinkingToSelectedModel();
		this.host.render();
		return true;
	}

	modelVisibilityModeActive(): boolean {
		return this.modelVisibilityMode && this.syncActivePopupMenu() === "model";
	}

	scrollActivePopupMenu(delta: number): boolean {
		const active = this.syncActivePopupMenu();
		if (!active) return false;

		this.getActivePopupMenu(active).scroll(delta);
		if (active === "model") this.syncModelThinkingToSelectedModel();
		this.host.render();
		return true;
	}

	selectActivePopupMenuIndex(index: number): ActivePopupMenu | undefined {
		const active = this.syncActivePopupMenu();
		if (!active) return undefined;
		const menu = this.getActivePopupMenu(active);
		menu.selectedIndex = index;
		menu.moveSelection(0);
		if (active === "model") this.syncModelThinkingToSelectedModel();
		this.host.render();
		return active;
	}

	handleDirectPopupInput(char: string): boolean {
		const active = this.directPopupMenu;
		if (!active) return false;
		if (active === "user-message") return char >= " " || char === "\u007f" || char === "\b";

		if (char === "\u007f" || char === "\b") {
			this.directPopupMenuQuery = this.directPopupMenuQuery.slice(0, -1);
			this.resetPopupMenuSelection(this.getActivePopupMenu(active));
			this.host.render();
			return true;
		}

		if (char >= " ") {
			this.directPopupMenuQuery += char;
			this.resetPopupMenuSelection(this.getActivePopupMenu(active));
			this.host.render();
			return true;
		}

		return false;
	}

	openDirectPopupMenu(menu: DirectPopupMenu, options: { preserveStatus?: boolean; placement?: PopupMenuPlacement } = {}): void {
		if (this.directPopupMenu === "sdk-menu" && menu !== "sdk-menu") {
			this.closeSdkMenu(undefined, { render: false, restoreStatus: false });
		}
		this.directPopupMenu = menu;
		if (menu === "model" || menu === "thinking") {
			this.resetModelThinkingState();
			this.modelThinkingSource = menu;
		}
		this.directPopupMenuPreserveStatus = options.preserveStatus === true;
		this.directPopupMenuPlacement = options.placement ?? "default";
		this.directPopupMenuQuery = "";
		if (menu !== "user-message") this.activeUserMessageEntryId = undefined;
		if (menu !== "queue-message") this.activeQueuedMessageEntryId = undefined;
		if (menu === "resume") this.resetResumeMenuLazyState();
		this.dismissedModelMenuInput = undefined;
		this.dismissedThinkingMenuInput = undefined;
		this.slashCommandMenu.close();
		this.modelMenu.close();
		this.resumeMenu.close();
		this.userMessageMenu.close();
		this.queueMessageMenu.close();
		this.sdkMenu.close();
		const popup = this.getActivePopupMenu(menu);
		this.resetPopupMenuSelection(popup);
	}

	popupMenuPlacement(): PopupMenuPlacement {
		return this.directPopupMenu ? this.directPopupMenuPlacement : "default";
	}

	openUserMessageMenu(entryId: string): boolean {
		if (!this.host.hasUserEntry(entryId)) return false;
		this.activeUserMessageEntryId = entryId;
		this.openDirectPopupMenu("user-message", { preserveStatus: true });
		return true;
	}

	openQueueMessageMenu(entryId: string): boolean {
		if (!this.host.hasQueuedEntry(entryId)) return false;
		this.activeQueuedMessageEntryId = entryId;
		this.openDirectPopupMenu("queue-message", { preserveStatus: true });
		return true;
	}

	openResumeMenuWithQuery(query: string): void {
		this.resetPopupMenuSelection(this.resumeMenu);
		this.resetResumeMenuLazyState(query);
		this.resumeMenu.openWithItems(this.withoutCloseMenuItems(this.host.getResumeMenuItems(query, this.resumeMenuSessionLimit)));
		this.updateResumeMenuLoadedState();
	}

	closeResumeMenu(): void {
		this.resumeMenu.close();
	}

	closeUserMessageMenu(): void {
		this.directPopupMenu = undefined;
		this.directPopupMenuQuery = "";
		this.directPopupMenuPreserveStatus = false;
		this.activeUserMessageEntryId = undefined;
		this.userMessageMenu.close();
		this.host.restoreSessionStatus();
	}

	closeUserMessageJumpMenu(): void {
		this.directPopupMenu = undefined;
		this.directPopupMenuQuery = "";
		this.directPopupMenuPreserveStatus = false;
		this.userMessageJumpMenu.close();
		this.host.restoreSessionStatus();
	}

	closeQueueMessageMenu(): void {
		this.directPopupMenu = undefined;
		this.directPopupMenuQuery = "";
		this.directPopupMenuPreserveStatus = false;
		this.activeQueuedMessageEntryId = undefined;
		this.queueMessageMenu.close();
		this.host.restoreSessionStatus();
	}

	resetConversationMenuState(): void {
		this.activeUserMessageEntryId = undefined;
		this.activeQueuedMessageEntryId = undefined;
		this.userMessageMenu.close();
		this.userMessageJumpMenu.close();
		this.queueMessageMenu.close();
		if (
			this.directPopupMenu === "user-message" ||
			this.directPopupMenu === "user-message-jump" ||
			this.directPopupMenu === "queue-message"
		) {
			this.directPopupMenu = undefined;
			this.directPopupMenuQuery = "";
			this.directPopupMenuPreserveStatus = false;
		}
	}

	closeModelSelection(): void {
		this.modelMenu.close();
		if (this.directPopupMenu === "model" || this.directPopupMenu === "thinking") this.directPopupMenu = undefined;
		this.directPopupMenuPreserveStatus = false;
		this.directPopupMenuQuery = "";
		this.dismissedModelMenuInput = undefined;
		this.dismissedThinkingMenuInput = undefined;
		this.resetModelThinkingState();
	}

	closeSlashCommandSelection(): void {
		this.slashCommandMenu.close();
		this.dismissedSlashCommandMenuInput = undefined;
	}

	closeMenusForTabSwitch(): void {
		if (this.directPopupMenu === "sdk-menu") {
			this.closeSdkMenu(undefined, { render: false, restoreStatus: false });
		}

		this.directPopupMenu = undefined;
		this.directPopupMenuQuery = "";
		this.directPopupMenuPreserveStatus = false;
		this.directPopupMenuPlacement = "default";
		this.activeUserMessageEntryId = undefined;
		this.activeQueuedMessageEntryId = undefined;
		this.slashCommandMenu.close();
		this.modelMenu.close();
		this.resumeMenu.close();
		this.userMessageMenu.close();
		this.userMessageJumpMenu.close();
		this.queueMessageMenu.close();
		this.sdkMenu.close();

		const input = this.host.getInput();
		this.dismissedSlashCommandMenuInput = input;
		this.dismissedModelMenuInput = input;
		this.dismissedThinkingMenuInput = input;
		this.resetModelThinkingState();
	}

	cancelActivePopupMenu(): void {
		const active = this.syncActivePopupMenu();
		if (this.directPopupMenu === "sdk-menu") {
			this.closeSdkMenu(undefined);
			return;
		}
		if (this.directPopupMenu) {
			const closingCombinedModelMenu = this.directPopupMenu === "model" || this.directPopupMenu === "thinking";
			this.directPopupMenu = undefined;
			this.directPopupMenuQuery = "";
			this.activeUserMessageEntryId = undefined;
			this.activeQueuedMessageEntryId = undefined;
			this.modelMenu.close();
			this.resumeMenu.close();
			this.userMessageMenu.close();
			this.userMessageJumpMenu.close();
			this.queueMessageMenu.close();
			this.sdkMenu.close();
			if (closingCombinedModelMenu) this.resetModelThinkingState();
			const preserveStatus = this.directPopupMenuPreserveStatus;
			this.directPopupMenuPreserveStatus = false;
			if (!preserveStatus) this.host.restoreSessionStatus();
			this.host.render();
			return;
		}

		if (active === "model") {
			this.dismissedModelMenuInput = this.host.getInput();
			this.dismissedThinkingMenuInput = this.host.getInput();
			this.modelMenu.close();
			this.resetModelThinkingState();
		} else if (active === "slash") {
			this.dismissedSlashCommandMenuInput = this.host.getInput();
			this.slashCommandMenu.close();
		}
		this.host.render();
	}

	autocompleteSlashCommand(): void {
		if (!this.syncSlashCommandMenu()) return;
		const selected = this.selectedSlashCommand();
		if (!selected) return;

		this.host.setInput(`/${selected.name}`);
		this.host.render();
	}

	autocompleteModel(): boolean {
		if (!this.syncModelMenu()) return false;
		const selected = this.selectedModelThinking();
		if (!selected) return true;

		if (selected.direct) return true;
		this.host.setInput(`/model ${selected.value.ref}:${selected.thinkingLevel}`);
		this.host.render();
		return true;
	}

	selectedSlashCommand(): SlashCommand | undefined {
		if (!this.syncSlashCommandMenu()) return undefined;
		return this.slashCommandMenu.selectedItem()?.value;
	}

	selectedModel(): { value: ModelMenuValue; direct: boolean } | undefined {
		if (!this.syncModelMenu()) return undefined;
		const value = this.modelMenu.selectedItem()?.value;
		if (!value) return undefined;
		return { value, direct: this.directPopupMenu === "model" || this.directPopupMenu === "thinking" };
	}

	selectedModelThinking(): {
		value: ModelMenuValue;
		thinkingLevel: ThinkingLevel;
		direct: boolean;
		source: "model" | "thinking";
	} | undefined {
		if (!this.syncModelMenu()) return undefined;
		const value = this.modelMenu.selectedItem()?.value;
		if (!value) return undefined;
		const state = this.modelThinkingMenuState();
		return {
			value,
			thinkingLevel: state.thinkingLevel,
			direct: this.directPopupMenu === "model" || this.directPopupMenu === "thinking",
			source: state.source,
		};
	}

	selectedResume(): ResumeMenuValue | undefined {
		if (!this.syncResumeMenu()) return undefined;
		return this.resumeMenu.selectedItem()?.value;
	}

	selectedUserMessageAction(): { value: UserMessageMenuValue; label: string; entryId: string } | undefined {
		if (!this.syncUserMessageMenu()) return undefined;
		const selected = this.userMessageMenu.selectedItem();
		const entryId = this.activeUserMessageEntryId;
		if (!selected || !entryId) return undefined;
		return { value: selected.value, label: selected.label, entryId };
	}

	selectedUserMessageJump(): UserMessageJumpMenuValue | undefined {
		if (!this.syncUserMessageJumpMenu()) return undefined;
		return this.userMessageJumpMenu.selectedItem()?.value;
	}

	selectedQueueMessageAction(): { value: QueueMessageMenuValue; label: string; entryId: string } | undefined {
		if (!this.syncQueueMessageMenu()) return undefined;
		const selected = this.queueMessageMenu.selectedItem();
		const entryId = this.activeQueuedMessageEntryId;
		if (!selected || !entryId) return undefined;
		return { value: selected.value, label: selected.label, entryId };
	}

	submitSelectedSdkMenu(): boolean {
		if (!this.syncSdkMenu()) return false;
		this.closeSdkMenu(this.sdkMenu.selectedItem()?.value.value);
		return true;
	}

	syncActivePopupMenu(): ActivePopupMenu | undefined {
		if (this.syncQueueMessageMenu()) return "queue-message";
		if (this.syncUserMessageMenu()) return "user-message";
		if (this.syncUserMessageJumpMenu()) return "user-message-jump";
		if (this.syncResumeMenu()) return "resume";
		if (this.syncSdkMenu()) return "sdk-menu";
		if (this.syncModelMenu()) return "model";
		if (this.syncSlashCommandMenu()) return "slash";
		return undefined;
	}

	renderActivePopupMenu(width: number): RenderedLine[] {
		if (this.syncQueueMessageMenu()) return this.renderer.renderQueueMessageMenu(width, this.queueMessageMenu);
		if (this.syncUserMessageMenu()) return this.renderer.renderUserMessageMenu(width, this.userMessageMenu);
		if (this.syncUserMessageJumpMenu()) return this.renderer.renderUserMessageJumpMenu(width, this.userMessageJumpMenu, this.directPopupMenuQuery);
		if (this.syncResumeMenu()) {
			return this.renderer.renderResumeMenu(width, this.resumeMenu, {
				directQuery: this.directPopupMenuQuery,
				allSessionsLoaded: this.resumeMenuAllSessionsLoaded,
				loadedSessionCount: this.resumeMenuLoadedSessionCount(),
			});
		}
		if (this.syncSdkMenu()) return this.renderer.renderSdkMenu(width, this.sdkMenu, this.sdkMenuRequest, this.directPopupMenuQuery);
		if (this.syncModelMenu()) return this.renderer.renderModelMenu(width, this.modelMenu, this.modelThinkingMenuState());
		return this.syncSlashCommandMenu() ? this.renderer.renderSlashCommandMenu(width, this.slashCommandMenu) : [];
	}

	popupMenuWidth(columns: number): number {
		return this.renderer.popupMenuWidth(columns);
	}

	popupMenuMargin(columns: number): number {
		return this.renderer.popupMenuMargin(columns);
	}

	effectivePopupMenuWidth(columns: number): number {
		return this.renderer.effectivePopupMenuWidth(columns);
	}

	styleOverlayLine(row: number, line: RenderedLine, width: number): string {
		const activeMenuName = this.syncActivePopupMenu() ?? "slash";
		const activeMenu = this.getActivePopupMenu(activeMenuName);
		return this.renderer.styleOverlayLine(row, line, width, activeMenu);
	}

	overlayPlainText(line: RenderedLine, width: number): string {
		return this.renderer.overlayPlainText(line, width);
	}

	isDynamicConversationBlock(entry: Entry): boolean {
		void entry;
		return false;
}

	hasDynamicConversationBlock(): boolean {
		return false;
}

	renderInlineUserMessageMenu(
		entry: Extract<Entry, { kind: "user" }>,
		options: {
			userContentWidth: number;
			userContentLeft: number;
			userLine: (text: string, entryId?: string, syntaxHighlight?: RenderedLine["syntaxHighlight"]) => RenderedLine;
		},
	): RenderedLine[] {
		void entry;
		void options;
		return [];
	}

	private withoutCloseMenuItems<T>(items: readonly PopupMenuItem<T>[]): PopupMenuItem<T>[] {
		return items.filter((item) => item.label.trim().toLowerCase() !== "cancel");
	}

	private resetPopupMenuSelection<T>(menu: PopupMenu<T>): void {
		menu.selectedIndex = 0;
		menu.scrollOffset = 0;
	}

	private resetResumeMenuLazyState(query = this.directPopupMenuQuery): void {
		this.resumeMenuQuery = query;
		this.resumeMenuSessionLimit = RESUME_MENU_INITIAL_SESSION_ROWS;
		this.resumeMenuAllSessionsLoaded = false;
	}

	private maybeGrowResumeMenuWindow(query: string): void {
		if (this.resumeMenuQuery !== query) {
			this.resetResumeMenuLazyState(query);
			return;
		}
		if (this.resumeMenuAllSessionsLoaded || this.resumeMenu.items.length === 0) return;

		const loadThresholdIndex = Math.max(0, this.resumeMenu.items.length - RESUME_MENU_LOAD_THRESHOLD_ROWS);
		const lastVisibleIndex = this.resumeMenu.scrollOffset + this.resumeMenu.maxVisibleRows - 1;
		if (this.resumeMenu.selectedIndex >= loadThresholdIndex || lastVisibleIndex >= loadThresholdIndex) {
			this.resumeMenuSessionLimit += RESUME_MENU_LOAD_BATCH_ROWS;
		}
	}

	private updateResumeMenuLoadedState(): void {
		const loadedSessions = this.resumeMenu.items.filter((item) => item.value.kind === "session").length;
		this.resumeMenuAllSessionsLoaded = loadedSessions < this.resumeMenuSessionLimit;
	}

	private resumeMenuLoadedSessionCount(): number {
		return this.resumeMenu.items.filter((item) => item.value.kind === "session").length;
	}

	private syncModelMenu(): boolean {
		if (this.directPopupMenu === "model" || this.directPopupMenu === "thinking") {
			const source = this.directPopupMenu;
			const opening = !this.modelMenu.open || this.modelThinkingSource !== source;
			if (opening) {
				this.resetPopupMenuSelection(this.modelMenu);
				this.resetModelThinkingState();
				this.modelThinkingSource = source;
			}
			this.closeMenusExcept("model");
			this.modelMenu.openWithItems(this.withoutCloseMenuItems(this.host.getModelMenuItems(this.directPopupMenuQuery, this.modelVisibilityMode)));
			this.syncModelThinkingToSelectedModel();
			return true;
		}

		const parsed = this.host.parseSlashInput(this.host.getInput());
		const source = parsed?.commandName.toLowerCase();
		const combinedSource = source === "model" || source === "thinking" ? source : undefined;
		const dismissed = combinedSource === "thinking"
			? this.dismissedThinkingMenuInput === this.host.getInput()
			: this.dismissedModelMenuInput === this.host.getInput();
		if (!combinedSource || dismissed) {
			if (this.modelMenu.open) this.resetModelThinkingState();
			this.modelMenu.close();
			return false;
		}

		const rawQuery = parsed?.hasArguments ? parsed.arguments : "";
		const normalizedThinkingQuery = rawQuery.trim().toLowerCase();
		const parsedQuery = combinedSource === "model"
			? this.modelThinkingQuery(rawQuery)
			: THINKING_LEVELS.includes(normalizedThinkingQuery as ThinkingLevel)
				? { modelQuery: "", thinkingQuery: normalizedThinkingQuery }
				: { modelQuery: rawQuery };
		const opening = !this.modelMenu.open || this.modelThinkingSource !== combinedSource;
		if (opening || this.modelMenuQuery !== parsedQuery.modelQuery) {
			this.resetPopupMenuSelection(this.modelMenu);
			this.modelMenuQuery = parsedQuery.modelQuery;
		}
		if (opening) {
			this.resetModelThinkingState();
			this.modelThinkingSource = combinedSource;
		}

		this.closeMenusExcept("model");
		this.modelMenu.openWithItems(this.withoutCloseMenuItems(this.host.getModelMenuItems(parsedQuery.modelQuery, this.modelVisibilityMode)));
		this.syncModelThinkingToSelectedModel();
		if (parsedQuery.thinkingQuery !== undefined && this.modelThinkingInputQuery !== parsedQuery.thinkingQuery) {
			this.modelThinkingInputQuery = parsedQuery.thinkingQuery;
			this.stageThinkingFromQuery(parsedQuery.thinkingQuery);
		}
		return true;
	}

	private modelThinkingQuery(query: string): { modelQuery: string; thinkingQuery?: string } {
		const trimmed = query.trim();
		const separator = trimmed.lastIndexOf(":");
		if (separator <= trimmed.indexOf("/")) return { modelQuery: query };
		const thinkingQuery = trimmed.slice(separator + 1).toLowerCase();
		if (!THINKING_LEVELS.includes(thinkingQuery as ThinkingLevel)) return { modelQuery: query };
		return { modelQuery: trimmed.slice(0, separator), thinkingQuery };
	}

	private stageThinkingFromQuery(query: string): void {
		if (!query.trim()) return;
		const normalized = query.trim().toLowerCase();
		const level = THINKING_LEVELS.includes(normalized as ThinkingLevel)
			? normalized as ThinkingLevel
			: this.host.getThinkingMenuItems(query)[0]?.value.level;
		if (!level) return;
		this.modelThinkingLevel = this.clampThinkingLevel(level, this.selectedModelThinkingLevels());
	}

	private modelThinkingMenuState(): ModelThinkingMenuState {
		this.syncModelThinkingToSelectedModel();
		const availableThinkingLevels = this.selectedModelThinkingLevels();
		return {
			thinkingLevel: this.modelThinkingLevel ?? availableThinkingLevels[0] ?? "off",
			availableThinkingLevels,
			source: this.modelThinkingSource,
			visibilityMode: this.modelVisibilityMode,
		};
	}

	private syncModelThinkingToSelectedModel(): void {
		const selected = this.modelMenu.selectedItem()?.value;
		if (!selected) {
			this.modelThinkingSelectedRef = undefined;
			return;
		}
		const levels = this.selectedModelThinkingLevels();
		const initial = this.modelThinkingLevel ?? this.host.session?.thinkingLevel ?? "off";
		if (this.modelThinkingSelectedRef !== selected.ref || this.modelThinkingLevel === undefined) {
			this.modelThinkingLevel = this.clampThinkingLevel(initial, levels);
			this.modelThinkingSelectedRef = selected.ref;
		}
	}

	private selectedModelThinkingLevels(): ThinkingLevel[] {
		const model = this.modelMenu.selectedItem()?.value.model;
		if (!model) return ["off"];
		const supported = getSupportedThinkingLevels(model);
		const levels = THINKING_LEVELS.filter((level) => supported.includes(level));
		return levels.length > 0 ? levels : ["off"];
	}

	private clampThinkingLevel(level: ThinkingLevel, availableLevels: readonly ThinkingLevel[]): ThinkingLevel {
		if (availableLevels.includes(level)) return level;
		const requestedIndex = THINKING_LEVELS.indexOf(level);
		for (let index = Math.max(0, requestedIndex); index < THINKING_LEVELS.length; index += 1) {
			const candidate = THINKING_LEVELS[index];
			if (candidate && availableLevels.includes(candidate)) return candidate;
		}
		for (let index = requestedIndex - 1; index >= 0; index -= 1) {
			const candidate = THINKING_LEVELS[index];
			if (candidate && availableLevels.includes(candidate)) return candidate;
		}
		return availableLevels[0] ?? "off";
	}

	private resetModelThinkingState(): void {
		this.modelThinkingLevel = undefined;
		this.modelThinkingSelectedRef = undefined;
		this.modelMenuQuery = "";
		this.modelThinkingInputQuery = "";
		this.modelVisibilityMode = false;
	}

	private syncResumeMenu(): boolean {
		if (this.directPopupMenu !== "resume") {
			this.resumeMenu.close();
			return false;
		}

		this.closeMenusExcept("resume");
		this.maybeGrowResumeMenuWindow(this.directPopupMenuQuery);
		this.resumeMenu.openWithItems(this.withoutCloseMenuItems(this.host.getResumeMenuItems(this.directPopupMenuQuery, this.resumeMenuSessionLimit)));
		this.updateResumeMenuLoadedState();
		return true;
	}

	private syncUserMessageMenu(): boolean {
		if (this.directPopupMenu !== "user-message" || !this.activeUserMessageEntryId) {
			this.userMessageMenu.close();
			if (this.directPopupMenu === "user-message") this.directPopupMenu = undefined;
			return false;
		}

		if (!this.host.hasUserEntry(this.activeUserMessageEntryId)) {
			this.userMessageMenu.close();
			this.activeUserMessageEntryId = undefined;
			this.directPopupMenu = undefined;
			return false;
		}

		this.closeMenusExcept("user-message");
		this.userMessageMenu.openWithItems(this.withoutCloseMenuItems(this.host.getUserMessageMenuItems()));
		return true;
	}

	private syncUserMessageJumpMenu(): boolean {
		if (this.directPopupMenu !== "user-message-jump") {
			this.userMessageJumpMenu.close();
			return false;
		}

		this.closeMenusExcept("user-message-jump");
		this.userMessageJumpMenu.openWithItems(this.withoutCloseMenuItems(this.host.getUserMessageJumpMenuItems(this.directPopupMenuQuery)));
		return true;
	}

	private syncQueueMessageMenu(): boolean {
		if (this.directPopupMenu !== "queue-message" || !this.activeQueuedMessageEntryId) {
			this.queueMessageMenu.close();
			if (this.directPopupMenu === "queue-message") this.directPopupMenu = undefined;
			return false;
		}

		if (!this.host.hasQueuedEntry(this.activeQueuedMessageEntryId)) {
			this.queueMessageMenu.close();
			this.activeQueuedMessageEntryId = undefined;
			this.directPopupMenu = undefined;
			return false;
		}

		this.closeMenusExcept("queue-message");
		this.queueMessageMenu.openWithItems(this.withoutCloseMenuItems(this.host.getQueueMessageMenuItems()));
		return true;
	}

	private syncSdkMenu(): boolean {
		if (this.directPopupMenu !== "sdk-menu" || !this.sdkMenuRequest) {
			this.sdkMenu.close();
			if (this.directPopupMenu === "sdk-menu") {
				this.directPopupMenu = undefined;
				this.directPopupMenuPreserveStatus = false;
				this.directPopupMenuQuery = "";
			}
			return false;
		}

		this.closeMenusExcept("sdk-menu");
		this.sdkMenu.openWithItems(this.getSdkMenuItems(this.directPopupMenuQuery));
		return true;
	}

	private syncSlashCommandMenu(): boolean {
		const parsed = this.host.parseSlashInput(this.host.getInput());
		if (!parsed || parsed.hasArguments || this.dismissedSlashCommandMenuInput === this.host.getInput()) {
			this.slashCommandMenu.close();
			return false;
		}

		if (this.slashCommandMenuQuery !== parsed.commandName) {
			this.resetPopupMenuSelection(this.slashCommandMenu);
			this.slashCommandMenuQuery = parsed.commandName;
		}

		this.slashCommandMenu.openWithItems(this.withoutCloseMenuItems(this.host.getSlashCommandMenuItems(parsed.commandName)));
		this.closeMenusExcept("slash");
		return true;
	}

	private closeMenusExcept(active: ActivePopupMenu): void {
		if (active !== "slash") this.slashCommandMenu.close();
		if (active !== "model") this.modelMenu.close();
		if (active !== "resume") this.resumeMenu.close();
		if (active !== "user-message") this.userMessageMenu.close();
		if (active !== "user-message-jump") this.userMessageJumpMenu.close();
		if (active !== "queue-message") this.queueMessageMenu.close();
		if (active !== "sdk-menu") this.sdkMenu.close();
	}

	private getSdkMenuItems(query: string): PopupMenuItem<SdkPopupMenuValue>[] {
		const request = this.sdkMenuRequest;
		if (!request) return [];

		const items = request.options.searchable === false || query.trim().length === 0
			? request.items
			: fuzzySearch(
				request.items.map((item): FuzzySearchItem<PixMenuItem<unknown>> => ({
					value: item,
					label: item.label,
					...(item.keywords === undefined ? {} : { keywords: item.keywords }),
				})),
				query,
				{
					...(request.options.minScorePerCharacter === undefined ? {} : { minScorePerCharacter: request.options.minScorePerCharacter }),
					preferKeyboardLayoutMatches: request.options.preferKeyboardLayoutMatches ?? false,
				},
			).map((match) => ({
				...match.value,
				labelHighlightRanges: match.matchedText === match.label ? match.matchedRanges : [],
			}));

		return this.withoutCloseMenuItems(items.map((item) => ({
			value: item,
			label: item.label,
			...(item.labelHighlightRanges === undefined ? {} : { labelHighlightRanges: item.labelHighlightRanges }),
			...(item.descriptionHighlightRanges === undefined ? {} : { descriptionHighlightRanges: item.descriptionHighlightRanges }),
			...(item.description === undefined ? {} : { description: item.description }),
		})));
	}

}

type SessionInfoTreeNode = {
	session: SessionInfo;
	children: SessionInfoTreeNode[];
};

type FlatSessionInfoTreeNode = {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	ancestorContinues: readonly boolean[];
};

type SessionInfoMenuSourceItem = {
	session: SessionInfo;
	labelPrefix: string;
	labelHighlightRanges?: readonly { start: number; end: number }[];
};

export type SessionInfoMenuItemsLoader = {
	readonly total: number;
	items(limit?: number): PopupMenuItem<SessionInfo>[];
};

function canonicalSessionPath(sessionPath: string | undefined): string | undefined {
	return sessionPath ? resolve(sessionPath) : undefined;
}

function buildSessionInfoTree(sessions: readonly SessionInfo[]): SessionInfoTreeNode[] {
	const byPath = new Map<string, SessionInfoTreeNode>();
	for (const session of sessions) {
		byPath.set(canonicalSessionPath(session.path) ?? session.path, { session, children: [] });
	}

	const roots: SessionInfoTreeNode[] = [];
	for (const session of sessions) {
		const sessionPath = canonicalSessionPath(session.path) ?? session.path;
		const node = byPath.get(sessionPath);
		if (!node) continue;

		const parentPath = canonicalSessionPath(session.parentSessionPath);
		const parent = parentPath ? byPath.get(parentPath) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}

	const sortNodes = (nodes: SessionInfoTreeNode[]): void => {
		nodes.sort((left, right) => right.session.modified.getTime() - left.session.modified.getTime());
		for (const node of nodes) sortNodes(node.children);
	};
	sortNodes(roots);

	return roots;
}

function flattenSessionInfoTree(roots: readonly SessionInfoTreeNode[]): FlatSessionInfoTreeNode[] {
	const result: FlatSessionInfoTreeNode[] = [];
	const walk = (node: SessionInfoTreeNode, depth: number, ancestorContinues: readonly boolean[], isLast: boolean): void => {
		result.push({ session: node.session, depth, isLast, ancestorContinues });
		for (let index = 0; index < node.children.length; index++) {
			const child = node.children[index];
			if (!child) continue;
			walk(child, depth + 1, [...ancestorContinues, depth > 0 && !isLast], index === node.children.length - 1);
		}
	};

	for (let index = 0; index < roots.length; index++) {
		const root = roots[index];
		if (!root) continue;
		walk(root, 0, [], index === roots.length - 1);
	}

	return result;
}

function sessionTreePrefix(node: FlatSessionInfoTreeNode): string {
	if (node.depth === 0) return "";
	return `${node.ancestorContinues.map((continues) => (continues ? "│  " : "   ")).join("")}${node.isLast ? "└─ " : "├─ "}`;
}

function formatSessionMenuDateTime(dateTime: Date): { date: string; time: string } {
	return {
		date: dateTime.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }),
		time: dateTime.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
	};
}

function formatSessionInfoMenuItem(source: SessionInfoMenuSourceItem): PopupMenuItem<SessionInfo> {
	const { session, labelPrefix } = source;
	const { date, time } = formatSessionMenuDateTime(session.modified);
	const messages = `${session.messageCount} msg${session.messageCount !== 1 ? "s" : ""}`;
	const label = session.name ?? session.firstMessage.slice(0, 50);
	return {
		value: session,
		label: `${labelPrefix}${label}`,
		description: `${date} ${time} · ${messages} · ${session.id.slice(0, 8)}`,
		...(source.labelHighlightRanges === undefined ? {} : { labelHighlightRanges: source.labelHighlightRanges }),
	};
}

function buildSessionInfoMenuSource(sessions: readonly SessionInfo[], currentSessionFile: string | undefined, query: string): SessionInfoMenuSourceItem[] {
	const visibleSessions = sessions.filter((session) => canonicalSessionPath(session.path) !== currentSessionFile);
	const trimmedQuery = query.trim();

	if (!trimmedQuery) {
		return flattenSessionInfoTree(buildSessionInfoTree(visibleSessions)).map((node) => ({
			session: node.session,
			labelPrefix: sessionTreePrefix(node),
		}));
	}

	const items: FuzzySearchItem<SessionInfo>[] = visibleSessions
		.map((session) => ({
			value: session,
			label: session.name ?? session.firstMessage.slice(0, 60),
			keywords: [
				session.cwd.split("/").pop() ?? session.cwd,
				session.id,
			],
		}));

	return fuzzySearch(items, query).map((match) => ({
		session: match.value,
		labelPrefix: "",
		labelHighlightRanges: match.matchedText === match.label ? match.matchedRanges : [],
	}));
}

export function createSessionInfoMenuItemsLoader(sessions: readonly SessionInfo[], currentSessionFile: string | undefined, query: string): SessionInfoMenuItemsLoader {
	const source = buildSessionInfoMenuSource(sessions, currentSessionFile, query);
	const cachedItems = new Map<number, PopupMenuItem<SessionInfo>[]>();

	return {
		get total() {
			return source.length;
		},
		items(limit?: number) {
			const effectiveLimit = limit === undefined ? source.length : Math.max(0, Math.min(limit, source.length));
			const cached = cachedItems.get(effectiveLimit);
			if (cached) return cached;

			const result = source.slice(0, effectiveLimit).map((item) => formatSessionInfoMenuItem(item));
			cachedItems.set(effectiveLimit, result);
			return result;
		},
	};
}

export function formatSessionInfoMenuItems(
	sessions: readonly SessionInfo[],
	currentSessionFile: string | undefined,
	query: string,
	options: { limit?: number } = {},
): PopupMenuItem<SessionInfo>[] {
	return createSessionInfoMenuItemsLoader(sessions, currentSessionFile, query).items(options.limit);
}

export type UserMessageJumpSourceItem = { text: string; entryId?: string; sessionEntryId?: string };
type SearchableUserMessageJumpMenuItem = PopupMenuItem<UserMessageJumpMenuValue> & { aliases?: string[]; keywords?: string[] };

export function buildUserMessageJumpItems(entries: readonly Entry[] | readonly UserMessageJumpSourceItem[]): PopupMenuItem<UserMessageJumpMenuValue>[] {
	const userEntries = entries.flatMap((entry): UserMessageJumpSourceItem[] => {
		if ("kind" in entry) {
			return entry.kind === "user"
				? [{ text: entry.text, entryId: entry.id, ...(entry.sessionEntryId === undefined ? {} : { sessionEntryId: entry.sessionEntryId }) }]
				: [];
		}
		return [entry];
	});
	return userEntries.map((entry, index): SearchableUserMessageJumpMenuItem => {
		const preview = sanitizeText(entry.text).replace(/\s+/g, " ").trim();
		const label = `${index + 1}. ${preview || "(empty message)"}`;
		return {
			value: {
				...(entry.entryId === undefined ? {} : { entryId: entry.entryId }),
				...(entry.sessionEntryId === undefined ? {} : { sessionEntryId: entry.sessionEntryId }),
				text: entry.text,
				userIndex: index,
				userCount: userEntries.length,
			},
			label,
			...(entry.entryId ? {} : { description: "load older history and jump" }),
			aliases: [entry.sessionEntryId ?? "", entry.entryId ?? ""],
			keywords: [entry.text],
		};
	});
}

export function filterUserMessageJumpItems(items: readonly PopupMenuItem<UserMessageJumpMenuValue>[], query: string): PopupMenuItem<UserMessageJumpMenuValue>[] {
	const searchableItems: FuzzySearchItem<SearchableUserMessageJumpMenuItem>[] = (items as readonly SearchableUserMessageJumpMenuItem[]).map((item) => ({
		value: item,
		label: item.label,
		...(item.aliases === undefined ? {} : { aliases: item.aliases }),
		...(item.keywords === undefined ? {} : { keywords: item.keywords }),
	}));

	return fuzzySearch(searchableItems, query).map((match) => ({
		...match.value,
		labelHighlightRanges: labelHighlightRangesFromMatch(match.matchedText, match.matchedRanges, match.label),
	}));
}

function labelHighlightRangesFromMatch(matchedText: string, matchedRanges: readonly { start: number; end: number }[], label: string): readonly { start: number; end: number }[] {
	if (matchedText === label) return matchedRanges;
	const offset = label.toLocaleLowerCase().indexOf(matchedText.toLocaleLowerCase());
	if (offset < 0) return [];
	return matchedRanges.map((range) => ({ start: offset + range.start, end: offset + range.end }));
}

export type {
	ModelPopupMenuValue,
	QueueMessagePopupMenuValue,
	ResumePopupMenuValue,
	SlashCommandMenuValue,
	UserMessageJumpPopupMenuValue,
	UserMessagePopupMenuValue,
};
