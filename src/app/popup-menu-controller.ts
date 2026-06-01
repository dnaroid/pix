import { resolve } from "node:path";
import { fuzzySearch, type FuzzySearchItem } from "../fuzzy.js";
import { colorLine, type Theme } from "../theme.js";
import { PopupMenu, type PopupMenuItem } from "../ui.js";
import { padOrTrimPlain, ellipsizeDisplay, sanitizeText } from "./render-text.js";
import { stringDisplayWidth } from "../terminal-width.js";
import {
	RESUME_MENU_INITIAL_SESSION_ROWS,
	RESUME_MENU_LOAD_BATCH_ROWS,
	RESUME_MENU_LOAD_THRESHOLD_ROWS,
	RESUME_MENU_MAX_ROWS,
	SLASH_COMMAND_DESCRIPTION_COLUMN,
	SLASH_COMMAND_MENU_MAX_ROWS,
	THINKING_MENU_MAX_ROWS,
} from "./constants.js";
import { APP_ICONS } from "./icons.js";
import type { ScreenStyler } from "./screen-styler.js";
import type {
	ActivePopupMenu,
	Entry,
	ModelMenuValue,
	ParsedSlashInput,
	PixMenuController,
	PixMenuItem,
	PixMenuOptions,
	PixMenuSelectOptions,
	PopupMenuPlacement,
	QueueMessageMenuValue,
	RenderedLine,
	ResumeMenuValue,
	SessionModel,
	SlashCommand,
	StyledSegment,
	ThinkingMenuValue,
	UserMessageJumpMenuValue,
	UserMessageMenuValue,
} from "./types.js";
import type { AgentSession, SessionInfo } from "@earendil-works/pi-coding-agent";

type SlashCommandMenuValue = SlashCommand;
type ModelPopupMenuValue = ModelMenuValue;
type ThinkingPopupMenuValue = ThinkingMenuValue;
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
type PopupLineVariant = NonNullable<RenderedLine["variant"]>;

const POPUP_MENU_ESCAPE_BUTTON = "Esc";

export type DirectPopupMenu = Exclude<ActivePopupMenu, "slash">;

export type AppPopupMenuControllerHost = {
	readonly theme: Theme;
	readonly screenStyler: ScreenStyler;
	readonly entries: readonly Entry[];
	readonly session: AgentSession | undefined;
	readonly resumeLoading: boolean;
	readonly resumeSessionCount: number;
	isRunning(): boolean;
	getInput(): string;
	setInput(value: string): void;
	parseSlashInput(text: string): ParsedSlashInput | undefined;
	getSlashCommandMenuItems(query: string): PopupMenuItem<SlashCommand>[];
	getModelMenuItems(query: string): PopupMenuItem<ModelMenuValue>[];
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
	private readonly thinkingMenu = new PopupMenu<ThinkingPopupMenuValue>({ maxVisibleRows: THINKING_MENU_MAX_ROWS });
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
	private thinkingMenuQuery = "";
	private dismissedThinkingMenuInput: string | undefined;
	private directPopupMenu: DirectPopupMenu | undefined;
	private directPopupMenuPreserveStatus = false;
	private directPopupMenuPlacement: PopupMenuPlacement = "default";
	private directPopupMenuQuery = "";
	private resumeMenuQuery = "";
	private resumeMenuSessionLimit = RESUME_MENU_INITIAL_SESSION_ROWS;
	private resumeMenuAllSessionsLoaded = false;
	private activeUserMessageEntryId: string | undefined;
	private activeQueuedMessageEntryId: string | undefined;

	constructor(private readonly host: AppPopupMenuControllerHost) {}

	get directMenu(): DirectPopupMenu | undefined {
		return this.directPopupMenu;
	}

	get directQuery(): string {
		return this.directPopupMenuQuery;
	}

	setDirectMenu(menu: DirectPopupMenu | undefined): void {
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
				return this.thinkingMenu;
			case "resume":
				return this.resumeMenu;
			case "slash":
				return this.slashCommandMenu;
		}
		throw new Error(`Unknown popup menu: ${active}`);
	}

	moveActivePopupMenuSelection(delta: number): boolean {
		const active = this.syncActivePopupMenu();
		if (!active) return false;

		this.getActivePopupMenu(active).moveSelection(delta);
		this.host.render();
		return true;
	}

	scrollActivePopupMenu(delta: number): boolean {
		const active = this.syncActivePopupMenu();
		if (!active) return false;

		this.getActivePopupMenu(active).scroll(delta);
		this.host.render();
		return true;
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
		this.thinkingMenu.close();
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
		this.directPopupMenu = undefined;
		this.directPopupMenuPreserveStatus = false;
		this.directPopupMenuQuery = "";
		this.dismissedModelMenuInput = undefined;
	}

	closeThinkingSelection(): void {
		this.thinkingMenu.close();
		this.directPopupMenu = undefined;
		this.directPopupMenuPreserveStatus = false;
		this.directPopupMenuQuery = "";
		this.dismissedThinkingMenuInput = undefined;
	}

	closeSlashCommandSelection(): void {
		this.slashCommandMenu.close();
		this.dismissedSlashCommandMenuInput = undefined;
	}

	cancelActivePopupMenu(): void {
		const active = this.syncActivePopupMenu();
		if (this.directPopupMenu === "sdk-menu") {
			this.closeSdkMenu(undefined);
			return;
		}
		if (this.directPopupMenu) {
			this.directPopupMenu = undefined;
			this.directPopupMenuQuery = "";
			this.activeUserMessageEntryId = undefined;
			this.activeQueuedMessageEntryId = undefined;
			this.modelMenu.close();
			this.thinkingMenu.close();
			this.resumeMenu.close();
			this.userMessageMenu.close();
			this.userMessageJumpMenu.close();
			this.queueMessageMenu.close();
			this.sdkMenu.close();
			const preserveStatus = this.directPopupMenuPreserveStatus;
			this.directPopupMenuPreserveStatus = false;
			if (!preserveStatus) this.host.restoreSessionStatus();
			this.host.render();
			return;
		}

		if (active === "model") {
			this.dismissedModelMenuInput = this.host.getInput();
			this.modelMenu.close();
		} else if (active === "thinking") {
			this.dismissedThinkingMenuInput = this.host.getInput();
			this.thinkingMenu.close();
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
		const selected = this.selectedModel();
		if (!selected) return true;

		if (selected.direct) return true;
		this.host.setInput(`/model ${selected.value.ref}`);
		this.host.render();
		return true;
	}

	autocompleteThinking(): boolean {
		if (!this.syncThinkingMenu()) return false;
		const selected = this.selectedThinking();
		if (!selected) return true;

		if (selected.direct) return true;
		this.host.setInput(`/thinking ${selected.value.level}`);
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
		return { value, direct: this.directPopupMenu === "model" };
	}

	selectedThinking(): { value: ThinkingMenuValue; direct: boolean } | undefined {
		if (!this.syncThinkingMenu()) return undefined;
		const value = this.thinkingMenu.selectedItem()?.value;
		if (!value) return undefined;
		return { value, direct: this.directPopupMenu === "thinking" };
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
		if (this.syncThinkingMenu()) return "thinking";
		if (this.syncSlashCommandMenu()) return "slash";
		return undefined;
	}

	renderActivePopupMenu(width: number): RenderedLine[] {
		if (this.syncQueueMessageMenu()) return this.renderQueueMessageMenu(width);
		// User-message actions are rendered inline inside the selected message block.
		// They must never also appear as the global popup above the input editor.
		if (this.syncUserMessageMenu()) return [];
		if (this.syncUserMessageJumpMenu()) return this.renderUserMessageJumpMenu(width);
		if (this.syncResumeMenu()) return this.renderResumeMenu(width);
		if (this.syncSdkMenu()) return this.renderSdkMenu(width);
		if (this.syncModelMenu()) return this.renderModelMenu(width);
		if (this.syncThinkingMenu()) return this.renderThinkingMenu(width);
		return this.renderSlashCommandMenu(width);
	}

	popupMenuWidth(columns: number): number {
		return columns;
	}

	popupMenuMargin(columns: number): number {
		return columns > 44 ? 2 : 0;
	}

	effectivePopupMenuWidth(columns: number): number {
		const sideMargin = this.popupMenuMargin(columns);
		return Math.min(this.popupMenuWidth(columns), Math.max(1, columns - sideMargin * 2));
	}

	styleOverlayLine(row: number, line: RenderedLine, width: number): string {
		const colors = this.host.theme.colors;
		const margin = this.popupMenuMargin(width);
		const menuWidth = this.effectivePopupMenuWidth(width);
		const rightMargin = Math.max(0, width - margin - menuWidth);
		const activeMenuName = this.syncActivePopupMenu() ?? "slash";
		const activeMenu = this.getActivePopupMenu(activeMenuName);
		const selected = line.target?.kind === "popup-menu" && activeMenu.selectedIndex === line.target.index;
		const foreground = this.popupLineForeground(line, selected);
		const background = this.popupLineBackground(line, selected);
		const plain = `${" ".repeat(margin)}${padOrTrimPlain(line.text, menuWidth)}${" ".repeat(rightMargin)}`;

		if (this.host.screenStyler.selectionRangeForRow(row, width)) {
			return this.host.screenStyler.styleLine(row, plain, width, { foreground, background });
		}

		return [
			colorLine("", margin, { background: colors.background }),
			line.segments && line.segments.length > 0
				? this.host.screenStyler.styleLineSegments(row, line.text, menuWidth, { foreground, background, bold: selected }, line.segments)
				: colorLine(line.text, menuWidth, { foreground, background, bold: selected }),
			colorLine("", rightMargin, { background: colors.background }),
		].join("");
	}

	overlayPlainText(line: RenderedLine, width: number): string {
		const margin = this.popupMenuMargin(width);
		const menuWidth = this.effectivePopupMenuWidth(width);
		const rightMargin = Math.max(0, width - margin - menuWidth);
		return `${" ".repeat(margin)}${padOrTrimPlain(line.text, menuWidth)}${" ".repeat(rightMargin)}`;
	}

	isDynamicConversationBlock(entry: Entry): boolean {
		return entry.kind === "user" && this.directPopupMenu === "user-message" && this.activeUserMessageEntryId === entry.id;
	}

	hasDynamicConversationBlock(): boolean {
		return this.directPopupMenu === "user-message" && this.activeUserMessageEntryId !== undefined;
	}

	renderInlineUserMessageMenu(
		entry: Extract<Entry, { kind: "user" }>,
		options: {
			userContentWidth: number;
			userContentLeft: number;
			userLine: (text: string, entryId?: string, syntaxHighlight?: RenderedLine["syntaxHighlight"]) => RenderedLine;
		},
	): RenderedLine[] {
		if (!(this.directPopupMenu === "user-message" && this.activeUserMessageEntryId === entry.id && this.syncUserMessageMenu())) return [];
		const headerLine = options.userLine(formatPopupMenuHeader("Message actions", options.userContentWidth));
		headerLine.target = { kind: "popup-menu-close" };
		headerLine.segments = [{
			start: options.userContentLeft,
			end: options.userContentLeft + options.userContentWidth,
			foreground: this.host.theme.colors.accent,
			background: this.host.theme.colors.popupHeaderBackground,
			bold: true,
		}];

		const lines: RenderedLine[] = [headerLine];
		for (const item of this.userMessageMenu.visibleItems()) {
			const label = item.label.padEnd(18, " ");
			const description = item.description ?? "";
			const marker = item.selected ? "›" : " ";
			const rawText = `${marker} ${label}${description}`;
			const text = ellipsizeDisplay(rawText, options.userContentWidth);
			const line = options.userLine(text);
			line.target = { kind: "popup-menu", index: item.index };

			const contentStart = options.userContentLeft;
			const labelStart = contentStart + 2;
			const labelEnd = Math.min(contentStart + text.length, labelStart + item.label.length);
			const descriptionStart = contentStart + 2 + label.length;
			line.segments = [
				...(item.selected ? [{ start: contentStart, end: contentStart + 1, foreground: this.host.theme.colors.accent, bold: true }] : []),
				{
					start: labelStart,
					end: labelEnd,
					foreground: this.userMessageActionForeground(item.selected, item.value),
					bold: item.selected,
				},
				...(descriptionStart < contentStart + text.length
					? [{ start: descriptionStart, end: contentStart + text.length, foreground: this.host.theme.colors.muted }]
					: []),
			];
			lines.push(line);
		}
		return lines;
	}

	private hasPopupActionItems<T>(items: readonly PopupMenuItem<T>[]): boolean {
		return items.length > 0;
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

	private userMessageActionForeground(selected: boolean, value: UserMessagePopupMenuValue): string {
		if (selected) return this.host.theme.colors.accent;
		if (value === "undo") return this.host.theme.colors.error;
		return this.host.theme.colors.inputForeground;
	}

	private selectableItemVariant(selected: boolean, value: ModelPopupMenuValue | ThinkingPopupMenuValue): PopupLineVariant {
		if (selected) return "accent";
		return value.current ? "muted" : "normal";
	}

	private queueMessageItemVariant(selected: boolean, value: QueueMessagePopupMenuValue): PopupLineVariant {
		if (selected) return "accent";
		return value === "cancel" ? "error" : "normal";
	}

	private sdkItemVariant(selected: boolean, value: SdkPopupMenuValue): PopupLineVariant {
		if (selected) return "accent";
		return value.variant ?? "normal";
	}

	private resumeMenuItemSegments(value: ResumePopupMenuValue, label: string, description: string, text: string): StyledSegment[] | undefined {
		if (value.kind !== "session") return undefined;

		const sessionLabel = value.session.name ?? value.session.firstMessage.slice(0, 50);
		const sessionLabelStart = Math.max(0, label.length - sessionLabel.length);
		const muted = this.host.theme.colors.popupMuted;
		const segments: StyledSegment[] = [];

		if (sessionLabelStart > 0) segments.push({ start: 0, end: sessionLabelStart, foreground: muted });
		if (description.length > 0) segments.push({ start: label.length, end: text.length, foreground: muted });

		return segments.length > 0 ? segments : undefined;
	}

	private popupMenuHeader(title: string, width: number): RenderedLine {
		return {
			text: formatPopupMenuHeader(title, width),
			variant: "accent",
			backgroundOverride: this.host.theme.colors.popupHeaderBackground,
			target: { kind: "popup-menu-close" },
		};
	}

	private syncModelMenu(): boolean {
		if (this.directPopupMenu === "model") {
			this.closeMenusExcept("model");
			this.modelMenu.openWithItems(this.withoutCloseMenuItems(this.host.getModelMenuItems(this.directPopupMenuQuery)));
			return true;
		}

		const parsed = this.host.parseSlashInput(this.host.getInput());
		if (parsed?.commandName.toLowerCase() !== "model" || this.dismissedModelMenuInput === this.host.getInput()) {
			this.modelMenu.close();
			return false;
		}

		const query = parsed.hasArguments ? parsed.arguments : "";
		if (this.modelMenuQuery !== query) {
			this.resetPopupMenuSelection(this.modelMenu);
			this.modelMenuQuery = query;
		}

		this.closeMenusExcept("model");
		this.modelMenu.openWithItems(this.withoutCloseMenuItems(this.host.getModelMenuItems(query)));
		return true;
	}

	private syncThinkingMenu(): boolean {
		if (this.directPopupMenu === "thinking") {
			this.closeMenusExcept("thinking");
			this.thinkingMenu.openWithItems(this.withoutCloseMenuItems(this.host.getThinkingMenuItems(this.directPopupMenuQuery)));
			return true;
		}

		const parsed = this.host.parseSlashInput(this.host.getInput());
		if (parsed?.commandName.toLowerCase() !== "thinking" || this.dismissedThinkingMenuInput === this.host.getInput()) {
			this.thinkingMenu.close();
			return false;
		}

		const query = parsed.hasArguments ? parsed.arguments : "";
		if (this.thinkingMenuQuery !== query) {
			this.resetPopupMenuSelection(this.thinkingMenu);
			this.thinkingMenuQuery = query;
		}

		this.closeMenusExcept("thinking");
		this.thinkingMenu.openWithItems(this.withoutCloseMenuItems(this.host.getThinkingMenuItems(query)));
		return true;
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
		if (active !== "thinking") this.thinkingMenu.close();
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
			).map((match) => match.value);

		return this.withoutCloseMenuItems(items.map((item) => ({
			value: item,
			label: item.label,
			...(item.description === undefined ? {} : { description: item.description }),
		})));
	}

	private renderSlashCommandMenu(_width: number): RenderedLine[] {
		if (!this.syncSlashCommandMenu()) return [];

		const lines: RenderedLine[] = [this.popupMenuHeader("Commands", _width)];
		const visibleItems = this.slashCommandMenu.visibleItems();
		if (!this.hasPopupActionItems(this.slashCommandMenu.items)) {
			lines.push({ text: "  No matching slash commands", variant: "muted" });
		}

		for (const item of visibleItems) {
			const command = item.label.padEnd(SLASH_COMMAND_DESCRIPTION_COLUMN, " ");
			const description = item.description ?? "";
			lines.push({
				text: `${command}${description}`,
				variant: item.selected ? "accent" : "normal",
				target: { kind: "popup-menu", index: item.index },
			});
		}
		return lines;
	}

	private renderModelMenu(_width: number): RenderedLine[] {
		if (!this.syncModelMenu()) return [];

		const lines: RenderedLine[] = [this.popupMenuHeader("Select model", _width)];
		const visibleItems = this.modelMenu.visibleItems();
		if (!this.hasPopupActionItems(this.modelMenu.items)) {
			lines.push({
				text: this.host.session ? "  No matching favorite models" : "  Model menu unavailable",
				variant: "muted",
			});
		}

		for (const item of visibleItems) {
			const model = item.label.padEnd(SLASH_COMMAND_DESCRIPTION_COLUMN, " ");
			const description = item.description ?? "";
			lines.push({
				text: `${model}${description}`,
				variant: this.selectableItemVariant(item.selected, item.value),
				target: { kind: "popup-menu", index: item.index },
			});
		}
		return lines;
	}

	private renderThinkingMenu(_width: number): RenderedLine[] {
		if (!this.syncThinkingMenu()) return [];

		const lines: RenderedLine[] = [this.popupMenuHeader("Thinking level", _width)];
		const visibleItems = this.thinkingMenu.visibleItems();
		if (!this.hasPopupActionItems(this.thinkingMenu.items)) {
			lines.push({ text: "  No matching thinking levels", variant: "muted" });
		}

		for (const item of visibleItems) {
			const level = item.label.padEnd(SLASH_COMMAND_DESCRIPTION_COLUMN, " ");
			const description = item.description ?? "";
			lines.push({
				text: `${level}${description}`,
				variant: this.selectableItemVariant(item.selected, item.value),
				target: { kind: "popup-menu", index: item.index },
			});
		}
		return lines;
	}

	private renderResumeMenu(_width: number): RenderedLine[] {
		if (!this.syncResumeMenu()) return [];

		const title = this.host.resumeLoading ? `Resume session ${APP_ICONS.timerSand}` : "Resume session";
		const lines: RenderedLine[] = [this.popupMenuHeader(title, _width)];
		const visibleItems = this.resumeMenu.visibleItems();
		if (!this.host.resumeLoading && !this.hasPopupActionItems(this.resumeMenu.items)) {
			lines.push({
				text: this.host.resumeSessionCount === 0 ? "  No sessions found" : "  No matching sessions",
				variant: "muted",
			});
		}

		for (const item of visibleItems) {
			const label = item.label;
			const description = item.description ?? "";
			const text = `${label}  ${description}`;
			const segments = this.resumeMenuItemSegments(item.value, label, description, text);
			lines.push({
				text,
				variant: item.selected ? "accent" : "normal",
				...(segments ? { segments } : {}),
				target: { kind: "popup-menu", index: item.index },
			});
		}

		if (!this.resumeMenuAllSessionsLoaded && this.resumeMenuLoadedSessionCount() > 0) {
			lines.push({ text: `  Loaded ${this.resumeMenuLoadedSessionCount()} sessions · scroll for more`, variant: "muted" });
		}

		if (this.directPopupMenuQuery) {
			lines.push({ text: `  Search: ${this.directPopupMenuQuery}`, variant: "muted" });
		}

		return lines;
	}

	private renderUserMessageJumpMenu(width: number): RenderedLine[] {
		if (!this.syncUserMessageJumpMenu()) return [];

		const lines: RenderedLine[] = [this.popupMenuHeader("Jump to user message", width)];
		if (!this.hasPopupActionItems(this.userMessageJumpMenu.items)) {
			lines.push({
				text: this.host.entries.some((entry) => entry.kind === "user") ? "  No matching user messages" : "  No user messages yet",
				variant: "muted",
			});
		}

		const labelWidth = Math.max(1, width);
		for (const item of this.userMessageJumpMenu.visibleItems()) {
			const label = ellipsizeDisplay(item.label, labelWidth);
			lines.push({
				text: label,
				variant: item.selected ? "accent" : "normal",
				target: { kind: "popup-menu", index: item.index },
			});
		}

		if (this.directPopupMenuQuery) {
			lines.push({ text: `  Search: ${this.directPopupMenuQuery}`, variant: "muted" });
		}
		return lines;
	}

	private renderQueueMessageMenu(_width: number): RenderedLine[] {
		if (!this.syncQueueMessageMenu()) return [];

		const lines: RenderedLine[] = [this.popupMenuHeader("Queued message", _width)];
		for (const item of this.queueMessageMenu.visibleItems()) {
			const label = item.label.padEnd(18, " ");
			const description = item.description ?? "";
			lines.push({
				text: `${label}${description}`,
				variant: this.queueMessageItemVariant(item.selected, item.value),
				target: { kind: "popup-menu", index: item.index },
			});
		}
		return lines;
	}

	private renderSdkMenu(_width: number): RenderedLine[] {
		if (!this.syncSdkMenu()) return [];

		const request = this.sdkMenuRequest;
		const lines: RenderedLine[] = [this.popupMenuHeader(request?.options.title ?? "Menu", _width)];
		if (!this.hasPopupActionItems(this.sdkMenu.items)) {
			lines.push({ text: `  ${request?.options.emptyText ?? "No matching items"}`, variant: "muted" });
		}

		for (const item of this.sdkMenu.visibleItems()) {
			const label = item.label.padEnd(SLASH_COMMAND_DESCRIPTION_COLUMN, " ");
			const description = item.description ?? "";
			lines.push({
				text: `${label}${description}`,
				variant: this.sdkItemVariant(item.selected, item.value),
				target: { kind: "popup-menu", index: item.index },
			});
		}

		if (request?.options.searchable !== false && this.directPopupMenuQuery) {
			lines.push({ text: `  ${request?.options.placeholder ?? "Search"}: ${this.directPopupMenuQuery}`, variant: "muted" });
		}

		return lines;
	}

	private popupLineForeground(line: RenderedLine, selected: boolean): string {
		const colors = this.host.theme.colors;
		if (selected) return colors.popupSelectedForeground;
		if (line.colorOverride) return line.colorOverride;

		switch (line.variant) {
			case "accent":
				return colors.accent;
			case "muted":
				return colors.popupMuted;
			case "error":
				return colors.error;
			case "normal":
			case undefined:
				return colors.popupForeground;
		}
		return colors.popupForeground;
	}

	private popupLineBackground(line: RenderedLine, selected: boolean): string {
		const colors = this.host.theme.colors;
		if (selected) return colors.popupSelectedBackground;
		return line.backgroundOverride ?? colors.popupBackground;
	}
}

export function formatPopupMenuHeader(title: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const sanitizedTitle = sanitizeText(title).replace(/\s+/g, " ").trim() || "Menu";
	const buttonWidth = stringDisplayWidth(POPUP_MENU_ESCAPE_BUTTON);

	if (safeWidth <= buttonWidth + 1) return padOrTrimPlain(POPUP_MENU_ESCAPE_BUTTON, safeWidth);

	const titleWidth = safeWidth - buttonWidth - 1;
	const titleText = ellipsizeDisplay(sanitizedTitle, titleWidth);
	const gapWidth = Math.max(1, safeWidth - stringDisplayWidth(titleText) - buttonWidth);
	return `${titleText}${" ".repeat(gapWidth)}${POPUP_MENU_ESCAPE_BUTTON}`;
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

function formatSessionInfoMenuItem(session: SessionInfo, labelPrefix = ""): PopupMenuItem<SessionInfo> {
	const { date, time } = formatSessionMenuDateTime(session.modified);
	const messages = `${session.messageCount} msg${session.messageCount !== 1 ? "s" : ""}`;
	const label = session.name ?? session.firstMessage.slice(0, 50);
	return {
		value: session,
		label: `${labelPrefix}${label}`,
		description: `${date} ${time} · ${messages} · ${session.id.slice(0, 8)}`,
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

	return fuzzySearch(items, query).map((match) => ({ session: match.value, labelPrefix: "" }));
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

			const result = source.slice(0, effectiveLimit).map((item) => formatSessionInfoMenuItem(item.session, item.labelPrefix));
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

export function buildUserMessageJumpItems(entries: readonly Entry[], query: string): PopupMenuItem<UserMessageJumpMenuValue>[] {
	const userEntries = entries.filter((entry): entry is Extract<Entry, { kind: "user" }> => entry.kind === "user");
	const items: FuzzySearchItem<UserMessageJumpMenuValue>[] = userEntries.map((entry, index) => {
		const preview = sanitizeText(entry.text).replace(/\s+/g, " ").trim();
		const label = `${index + 1}. ${preview || "(empty message)"}`;
		return {
			value: { entryId: entry.id },
			label,
			aliases: [entry.sessionEntryId ?? "", entry.id],
			keywords: [entry.text],
		};
	});

	return fuzzySearch(items, query).map((match) => ({
		value: match.value,
		label: match.label,
	}));
}

export type {
	ModelPopupMenuValue,
	QueueMessagePopupMenuValue,
	ResumePopupMenuValue,
	SlashCommandMenuValue,
	ThinkingPopupMenuValue,
	UserMessageJumpPopupMenuValue,
	UserMessagePopupMenuValue,
};
