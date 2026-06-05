import { copyTextToClipboard } from "./clipboard.js";
import type { AppCommandController } from "../commands/command-controller.js";
import type { ConversationViewport } from "../rendering/conversation-viewport.js";
import type { EditorLayoutRenderer } from "../rendering/editor-layout-renderer.js";
import type { ImageContent, InputEditor } from "../../input-editor.js";
import type { ToastEntry, ToastVariant } from "../../ui.js";
import { stringifyUnknown } from "../rendering/message-content.js";
import type { AppPopupActionController } from "../popup/popup-action-controller.js";
import type { AppPopupMenuController } from "../popup/popup-menu-controller.js";
import { horizontalPaddingLayout } from "../rendering/render-text.js";
import type { AppScrollController } from "./scroll-controller.js";
import { orderedSelection, samePoint } from "./screen-selection.js";
import { openImageContent as openSystemImageContent } from "./image-opener.js";
import { sliceByDisplayColumns, stringDisplayWidth } from "../../terminal-width.js";
import type {
	ConversationSelectionPoint,
	Entry,
	ImageClickTarget,
	MouseEvent,
	MouseSelection,
	RenderedLine,
	ScreenPoint,
	StatusContextTarget,
	StatusCompactToolsTarget,
	StatusDraftQueueTarget,
	StatusModelTarget,
	StatusModelUsageTarget,
	StatusPromptEnhancerTarget,
	StatusSessionTarget,
	StatusTerminalBellSoundTarget,
	TabLineMouseTarget,
	StatusThinkingExpandTarget,
	StatusThinkingTarget,
	StatusUserJumpTarget,
	StatusVoiceLanguageTarget,
	StatusVoiceMicTarget,
} from "../types.js";
import { formatDcpStatsToast } from "../rendering/dcp-stats.js";
import { detectFileLinks, type RenderedLink } from "./file-links.js";
import { openFileLink as openDetectedFileLink } from "./file-link-opener.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const CLICK_FLASH_MS = 100;
const LOST_MOUSE_RELEASE_SETTLE_MS = 180;

type ClickFlash = {
	y: number;
	startColumn: number;
	endColumn: number;
	text: string;
	background?: string;
};

type ClickFlashRegion = Omit<ClickFlash, "text">;

export type InputFrameCopyRows = {
	inputStartRow: number;
	inputEndRow: number;
	inputSeparatorRow: number;
	inputBottomSeparatorRow: number;
	contentStartColumn: number;
	contentEndColumn: number;
};

export type AppMouseControllerHost = {
	terminalColumns(): number;
	terminalRows(): number;
	tabPanelRows(terminalRows: number): number;
	conversationViewport(): ConversationViewport;
	editorLayoutRenderer(): EditorLayoutRenderer;
	inputEditor(): InputEditor;
	resetRequestHistoryNavigation(): void;
	findEntry(entryId: string): Entry | undefined;
	touchEntry(entry: Entry): void;
	getTodoPanelExpanded(): boolean;
	setTodoPanelExpanded(expanded: boolean): void;
	getSubagentsPanelExpanded(): boolean;
	setSubagentsPanelExpanded(expanded: boolean): void;
	setStatus(status: string): void;
	runtimeSession(): AgentSession | undefined;
	cwd(): string | undefined;
	openFileLink?(link: RenderedLink): boolean;
	openImageContent?(image: ImageContent): boolean;
	enhancePrompt(): void | Promise<void>;
	openNewTab(): void | Promise<void>;
	toggleVoiceRecording(): void;
	toggleVoiceLanguage(): void;
	switchToTab(tabId: string): void;
	closeTab(tabId: string): void;
	toastEntry(toastId: number): ToastEntry | undefined;
	showToast(message: string, kind: "success" | "error" | "warning" | "info", options?: { durationMs?: number; variant?: ToastVariant }): void;
	dismissToast(toastId: number): void;
	refreshModelUsageStatus(): void | Promise<void>;
	refreshUserMessageJumpMenuItems?(): Promise<void>;
	queueInputFromStatus?(): void | Promise<void>;
	toggleAllThinkingExpanded?(): void;
	toggleSuperCompactTools?(): void;
	toggleTerminalBellSound?(): void;
	copyTextToClipboard?(text: string): void | Promise<void>;
	handleExtensionInputMouse(event: MouseEvent & { localRow: number; localColumn: number; width: number }): boolean;
	render(): void;
};

export class AppMouseController {
	readonly renderedTargets = new Map<number, RenderedLine["target"]>();
	readonly renderedRowTexts = new Map<number, string>();
	readonly renderedRowBackgrounds = new Map<number, string>();
	readonly renderedImageTargets = new Map<number, readonly ImageClickTarget[]>();

	statusModelTarget: StatusModelTarget | undefined;
	statusThinkingTarget: StatusThinkingTarget | undefined;
	statusContextTarget: StatusContextTarget | undefined;
	statusModelUsageTarget: StatusModelUsageTarget | undefined;
	statusUserJumpTarget: StatusUserJumpTarget | undefined;
	statusDraftQueueTarget: StatusDraftQueueTarget | undefined;
	statusThinkingExpandTarget: StatusThinkingExpandTarget | undefined;
	statusCompactToolsTarget: StatusCompactToolsTarget | undefined;
	statusTerminalBellSoundTarget: StatusTerminalBellSoundTarget | undefined;
	statusSessionTarget: StatusSessionTarget | undefined;
	statusPromptEnhancerTarget: StatusPromptEnhancerTarget | undefined;
	statusVoiceMicTarget: StatusVoiceMicTarget | undefined;
	statusVoiceLanguageTarget: StatusVoiceLanguageTarget | undefined;
	readonly tabLineTargets: TabLineMouseTarget[] = [];
	mouseSelection: MouseSelection | undefined;
	private inputScrollBarDragActive = false;
	private autoScrollTimer: ReturnType<typeof setInterval> | undefined;
	private autoScrollDirection: -1 | 1 | undefined;
	private autoScrollDistance = 0;
	private autoScrollAccumulator = 0;
	private autoScrollLastTick = 0;
	private autoScrollCursorX = 1;
	private leftEdgeReleaseFallbackTimer: ReturnType<typeof setTimeout> | undefined;
	private clickFlash: ClickFlash | undefined;
	private clickFlashTimer: ReturnType<typeof setTimeout> | undefined;
	private clickFlashDirty = false;
	private renderedConversationFrame: {
		bodyHeight: number;
		topRow: number;
		viewportColumns: number;
	} | undefined;

	constructor(
		private readonly host: AppMouseControllerHost,
		private readonly popupMenus: AppPopupMenuController,
		private readonly popupActions: AppPopupActionController,
		private readonly scrollController: AppScrollController,
		private readonly commandController: AppCommandController,
	) {}

	handleMouse(event: MouseEvent): void {
		if (this.handleInputScrollBar(event)) return;
		this.showClickFlashOnPress(event);
		if (this.handleMouseSelection(event)) return;
		if (this.withClickFlash(event, () => this.handleImageClick(event))) return;
		if (this.withClickFlash(event, () => this.handleFileLinkClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleTabLineClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusModelClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusThinkingClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusContextClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusModelUsageClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusDraftQueueClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusUserJumpClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusThinkingExpandClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusCompactToolsClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusTerminalBellSoundClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusSessionClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusPromptEnhancerClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusVoiceMicClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleStatusVoiceLanguageClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleExtensionInputClick(event))) return;
		if (event.button === 0 && this.withClickFlash(event, () => this.handleInputClick(event))) return;
		const target = this.renderedTargets.get(event.y);

		if (event.button === 64) {
			if (target?.kind === "popup-menu") {
				this.popupMenus.scrollActivePopupMenu(-3);
				return;
			}
			if (this.handleInputWheel(event, -3)) return;
			this.scrollController.scrollByLines(-3);
			return;
		}
		if (event.button === 65) {
			if (target?.kind === "popup-menu") {
				this.popupMenus.scrollActivePopupMenu(3);
				return;
			}
			if (this.handleInputWheel(event, 3)) return;
			this.scrollController.scrollByLines(3);
			return;
		}
		if (event.button !== 0) return;

		if (target?.kind === "toast") {
			if (!toastTargetContainsEvent(target, event)) return;
			if (target.action === "body") return;
			if (this.copyErrorToast(target.id)) {
				this.showClickFlashForEvent(event);
				return;
			}
			this.host.dismissToast(target.id);
			this.showClickFlashForEvent(event);
			return;
		}

		if (target?.kind === "popup-menu") {
			const activeMenu = this.popupMenus.getActivePopupMenu(this.popupMenus.syncActivePopupMenu() ?? "slash");
			activeMenu.selectedIndex = target.index;
			activeMenu.moveSelection(0);
			void this.popupActions.submitActivePopupMenu();
			this.showClickFlashForEvent(event);
			return;
		}

		if (target?.kind === "popup-menu-close") {
			this.popupMenus.cancelActivePopupMenu();
			this.showClickFlashForEvent(event);
			return;
		}

		if (target?.kind === "todo-panel") {
			this.host.setTodoPanelExpanded(!this.host.getTodoPanelExpanded());
			this.showClickFlashForEvent(event);
			return;
		}

		if (target?.kind === "subagents-panel") {
			this.host.setSubagentsPanelExpanded(!this.host.getSubagentsPanelExpanded());
			this.showClickFlashForEvent(event);
			return;
		}

		if (target?.kind === "user-message") {
			this.openUserMessageMenu(target.id);
			this.showClickFlashForEvent(event);
			return;
		}

		if (target?.kind === "queue-message") {
			this.openQueueMessageMenu(target.id);
			this.showClickFlashForEvent(event);
			return;
		}

		if (target?.kind === "tool") {
			const entry = this.host.findEntry(target.id);
			if (entry?.kind === "tool" || entry?.kind === "thinking" || entry?.kind === "shell") {
				entry.expanded = !entry.expanded;
				this.host.touchEntry(entry);
				this.showClickFlashForEvent(event);
			}
		}
	}

	activeClickFlash(): ClickFlash | undefined {
		return this.clickFlash;
	}

	consumeClickFlashDirty(): boolean {
		const dirty = this.clickFlashDirty;
		this.clickFlashDirty = false;
		return dirty;
	}

	private withClickFlash(event: MouseEvent, handler: () => boolean): boolean {
		const flash = this.clickFlashForEvent(event);
		if (!handler()) return false;
		if (!event.released) this.showClickFlash(flash);
		return true;
	}

	private showClickFlashOnPress(event: MouseEvent): void {
		if (event.released || event.button !== 0) return;
		const region = this.clickFlashRegionForEvent(event) ?? this.inputClickFlashRegionForEvent(event);
		if (!region) return;
		this.showClickFlash(this.clickFlashForRegion(region));
	}

	private showClickFlashForEvent(event: MouseEvent): void {
		if (event.released) return;
		this.showClickFlash(this.clickFlashForEvent(event));
	}

	private showClickFlash(flash: ClickFlash): void {
		if (this.clickFlashTimer) clearTimeout(this.clickFlashTimer);
		this.clickFlash = flash;
		this.clickFlashDirty = true;
		this.host.render();

		this.clickFlashTimer = setTimeout(() => {
			this.clickFlash = undefined;
			this.clickFlashTimer = undefined;
			this.clickFlashDirty = true;
			this.host.render();
		}, CLICK_FLASH_MS);
	}

	private clickFlashForEvent(event: MouseEvent): ClickFlash {
		return this.clickFlashForRegion(this.clickFlashRegionForEvent(event) ?? {
			y: event.y,
			startColumn: event.x,
			endColumn: event.x + 1,
		});
	}

	private clickFlashForRegion(region: ClickFlashRegion): ClickFlash {
		const normalizedRegion = this.normalizedClickFlashRegion(region);
		const background = this.renderedRowBackgrounds.get(normalizedRegion.y);

		return {
			...normalizedRegion,
			text: displayCellsInColumnRange(
				this.renderedRowTexts.get(normalizedRegion.y) ?? "",
				normalizedRegion.startColumn,
				normalizedRegion.endColumn,
			),
			...(background === undefined ? {} : { background }),
		};
	}

	private clickFlashRegionForEvent(event: MouseEvent): ClickFlashRegion | undefined {
		const imageTarget = this.imageTargetAt(event);
		if (imageTarget) return { y: event.y, startColumn: imageTarget.start + 1, endColumn: imageTarget.end + 1 };

		const link = this.fileLinkAt(event);
		if (link) return { y: event.y, startColumn: link.start + 1, endColumn: link.end + 1 };

		const tabTarget = this.tabLineTargetAt(event);
		if (tabTarget) return { y: tabTarget.row, startColumn: tabTarget.startColumn, endColumn: tabTarget.endColumn };

		const statusTarget = this.statusTargetAt(event);
		if (statusTarget) return statusTarget;

		const toastTarget = this.renderedTargets.get(event.y);
		if (toastTarget?.kind === "toast" && toastTargetContainsEvent(toastTarget, event)) {
			return {
				y: event.y,
				startColumn: toastTarget.startColumn ?? event.x,
				endColumn: toastTarget.endColumn ?? event.x + 1,
			};
		}

		if (this.renderedTargets.has(event.y)) {
			const bounds = nonBlankLineBounds(this.renderedRowTexts.get(event.y) ?? "", event.x);
			return { y: event.y, startColumn: bounds.startColumn, endColumn: bounds.endColumn };
		}

		return undefined;
	}

	private normalizedClickFlashRegion(region: ClickFlashRegion): ClickFlashRegion {
		const columns = Math.max(1, this.host.terminalColumns());
		const y = Math.max(1, region.y);
		const startColumn = Math.max(1, Math.min(columns, region.startColumn));
		const endColumn = Math.max(startColumn + 1, Math.min(columns + 1, region.endColumn));
		return { y, startColumn, endColumn };
	}

	private inputClickFlashRegionForEvent(event: MouseEvent): ClickFlashRegion | undefined {
		if (!this.inputGeometry(event)) return undefined;
		return { y: event.y, startColumn: event.x, endColumn: event.x + 1 };
	}

	private imageTargetAt(event: MouseEvent): ImageClickTarget | undefined {
		const targets = this.renderedImageTargets.get(event.y);
		return targets?.find((candidate) => event.x >= candidate.start + 1 && event.x <= candidate.end);
	}

	private fileLinkAt(event: MouseEvent): RenderedLink | undefined {
		const text = this.renderedRowTexts.get(event.y);
		if (!text) return undefined;
		return detectFileLinks(text, this.host.cwd()).find((candidate) => event.x >= candidate.start + 1 && event.x <= candidate.end);
	}

	private statusTargetAt(event: MouseEvent): ClickFlashRegion | undefined {
		const target = [
			this.statusModelTarget,
			this.statusThinkingTarget,
			this.statusContextTarget,
			this.statusModelUsageTarget,
			this.statusDraftQueueTarget,
			this.statusUserJumpTarget,
			this.statusThinkingExpandTarget,
			this.statusCompactToolsTarget,
			this.statusSessionTarget,
			this.statusPromptEnhancerTarget,
			this.statusVoiceMicTarget,
			this.statusVoiceLanguageTarget,
		].find((candidate) => !!candidate
			&& event.y === candidate.row
			&& event.x >= candidate.startColumn
			&& event.x < candidate.endColumn);
		if (!target) return undefined;
		return {
			y: target.row,
			startColumn: target.startColumn,
			endColumn: target.endColumn,
		};
	}

	private handleImageClick(event: MouseEvent): boolean {
		if (event.button !== 0 || !event.released) return false;

		const imageTarget = this.imageTargetAt(event);
		if (!imageTarget) return false;

		const entry = this.host.findEntry(imageTarget.entryId);
		const images = entry?.kind === "user" || entry?.kind === "tool" ? entry.images : undefined;
		const image = images?.[imageTarget.imageIndex];
		if (!image) {
			this.host.showToast("Image data is not available for this message.", "warning");
			return true;
		}

		const opened = this.host.openImageContent?.(image) ?? openSystemImageContent(image);
		this.host.showToast(opened ? "Opened image." : "Could not open image with the system viewer.", opened ? "success" : "warning");
		return true;
	}

	private handleFileLinkClick(event: MouseEvent): boolean {
		const modifiedPress = isModifiedPrimaryButton(event.button) && !event.released;
		const plainRelease = event.button === 0 && event.released;
		if (!modifiedPress && !plainRelease) return false;

		const link = this.fileLinkAt(event);
		if (!link) return false;

		const opened = this.host.openFileLink?.(link) ?? openDetectedFileLink(link);
		if (!opened) this.host.showToast("Could not open file link. Install the Zed CLI or set ZED_CLI.", "warning");
		return true;
	}

	private handleInputScrollBar(event: MouseEvent): boolean {
		if (!this.inputScrollBarDragActive && this.tabLineTargetAt(event)) return false;

		const geometry = this.inputGeometry(event);
		if (!geometry?.renderedInput.scrollBar) return this.finishInputScrollBarDrag(event);

		const { renderedInput, localY, inputStartRow } = geometry;
		const scrollBar = renderedInput.scrollBar!;
		const editorRow = localY - inputStartRow - renderedInput.editorStartRowOffset;
		const insideTrack = editorRow >= 0 && editorRow < scrollBar.trackHeight;
		const onScrollBar = insideTrack && event.x === this.host.terminalColumns();
		const baseButton = event.button & 3;
		const draggingLeftButton = (event.button & 32) !== 0 && baseButton === 0;

		if (event.released) return this.finishInputScrollBarDrag(event);

		if (event.button === 0 && onScrollBar) {
			this.inputScrollBarDragActive = true;
			this.scrollInputToTrackRow(editorRow, scrollBar.trackHeight, renderedInput.totalLineCount, renderedInput.visibleRowCount);
			return true;
		}

		if (!draggingLeftButton || !this.inputScrollBarDragActive) return false;
		const trackRow = Math.max(0, Math.min(scrollBar.trackHeight - 1, editorRow));
		this.scrollInputToTrackRow(trackRow, scrollBar.trackHeight, renderedInput.totalLineCount, renderedInput.visibleRowCount);
		return true;
	}

	private finishInputScrollBarDrag(event: MouseEvent): boolean {
		if (!event.released) return false;
		if (!this.inputScrollBarDragActive) return false;
		this.inputScrollBarDragActive = false;
		return true;
	}

	private handleInputWheel(event: MouseEvent, delta: number): boolean {
		const geometry = this.inputGeometry(event);
		if (!geometry) return false;

		const { renderedInput, localY, inputStartRow, contentWidth } = geometry;
		const inputEndRow = inputStartRow + renderedInput.lines.length;
		const editorStartRow = inputStartRow + renderedInput.editorStartRowOffset;
		if (localY < editorStartRow || localY >= inputEndRow) return false;

		if (this.host.inputEditor().scrollByVisualLines(delta, contentWidth, renderedInput.visibleRowCount, "", "")) {
			this.host.render();
		}
		return true;
	}

	private scrollInputToTrackRow(trackRow: number, trackHeight: number, totalLineCount: number, visibleRowCount: number): void {
		const maxScroll = Math.max(0, totalLineCount - visibleRowCount);
		const ratio = trackHeight <= 1 ? 0 : trackRow / (trackHeight - 1);
		const scrollOffset = Math.round(maxScroll * ratio);
		const { contentWidth } = horizontalPaddingLayout(this.host.terminalColumns());
		if (this.host.inputEditor().setVisualScrollOffset(scrollOffset, contentWidth, visibleRowCount, "", "")) {
			this.host.render();
		}
	}

	private inputGeometry(event: MouseEvent): {
		renderedInput: ReturnType<EditorLayoutRenderer["computeLayout"]>["renderedInput"];
		inputStartRow: number;
		localY: number;
		contentWidth: number;
	} | undefined {
		const columns = this.host.terminalColumns();
		const terminalRows = this.host.terminalRows();
		const tabPanelRows = this.host.tabPanelRows(terminalRows);
		const rows = editorLayoutRows(terminalRows, tabPanelRows);
		const localY = event.y - editorLayoutTopOffset(tabPanelRows);
		const { renderedInput, inputStartRow } = this.host.editorLayoutRenderer().computeLayout(columns, rows);
		const inputEndRow = inputStartRow + renderedInput.lines.length;
		if (localY < inputStartRow || localY >= inputEndRow) return undefined;

		const { contentWidth } = horizontalPaddingLayout(columns);
		return { renderedInput, inputStartRow, localY, contentWidth };
	}

	private tabLineTargetAt(event: MouseEvent): TabLineMouseTarget | undefined {
		return this.tabLineTargets.find((candidate) => (
			event.y === candidate.row
			&& event.x >= candidate.startColumn
			&& event.x < candidate.endColumn
		));
	}

	private handleTabLineClick(event: MouseEvent): boolean {
		const target = this.tabLineTargetAt(event);
		if (!target) return false;

		if (target.kind === "new-tab") this.host.openNewTab();
		else if (target.kind === "close") this.host.closeTab(target.tabId);
		else if (target.active) void this.commandController.runResumeCommand({ preserveStatus: true, placement: "under-tabs" });
		else this.host.switchToTab(target.tabId);
		return true;
	}

	private handleStatusModelClick(event: MouseEvent): boolean {
		const target = this.statusModelTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		this.popupMenus.openDirectPopupMenu("model");
		this.host.render();
		return true;
	}

	private handleStatusThinkingClick(event: MouseEvent): boolean {
		const target = this.statusThinkingTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		this.popupMenus.openDirectPopupMenu("thinking");
		this.host.render();
		return true;
	}

	private handleStatusContextClick(event: MouseEvent): boolean {
		const target = this.statusContextTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		const session = this.host.runtimeSession();
		if (!session) return false;
		const message = formatDcpStatsToast(session);
		this.host.showToast(message, "info", { variant: "dialog" });
		return true;
	}

	private handleStatusModelUsageClick(event: MouseEvent): boolean {
		const target = this.statusModelUsageTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		void this.host.refreshModelUsageStatus();
		return true;
	}

	private handleStatusUserJumpClick(event: MouseEvent): boolean {
		const target = this.statusUserJumpTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		void this.openStatusUserJumpMenu();
		return true;
	}

	private async openStatusUserJumpMenu(): Promise<void> {
		try {
			const refreshPromise = this.host.refreshUserMessageJumpMenuItems?.();
			this.popupMenus.openDirectPopupMenu("user-message-jump", { preserveStatus: true });
			this.host.render();
			if (this.host.refreshUserMessageJumpMenuItems) {
				await refreshPromise;
				this.host.render();
			}
		} catch (error) {
			this.host.showToast(`Could not load jump messages: ${error instanceof Error ? error.message : stringifyUnknown(error)}`, "error");
			this.host.render();
		}
	}

	private handleStatusDraftQueueClick(event: MouseEvent): boolean {
		const target = this.statusDraftQueueTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		void this.host.queueInputFromStatus?.();
		return true;
	}

	private handleStatusThinkingExpandClick(event: MouseEvent): boolean {
		const target = this.statusThinkingExpandTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		this.host.toggleAllThinkingExpanded?.();
		return true;
	}

	private handleStatusCompactToolsClick(event: MouseEvent): boolean {
		const target = this.statusCompactToolsTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		this.host.toggleSuperCompactTools?.();
		return true;
	}

	private handleStatusTerminalBellSoundClick(event: MouseEvent): boolean {
		const target = this.statusTerminalBellSoundTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		this.host.toggleTerminalBellSound?.();
		return true;
	}

	private handleStatusSessionClick(event: MouseEvent): boolean {
		const target = this.statusSessionTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		void this.commandController.runResumeCommand({ preserveStatus: true });
		return true;
	}

	private handleStatusPromptEnhancerClick(event: MouseEvent): boolean {
		const target = this.statusPromptEnhancerTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		void this.host.enhancePrompt();
		return true;
	}

	private handleStatusVoiceMicClick(event: MouseEvent): boolean {
		const target = this.statusVoiceMicTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		this.host.toggleVoiceRecording();
		return true;
	}

	private handleStatusVoiceLanguageClick(event: MouseEvent): boolean {
		const target = this.statusVoiceLanguageTarget;
		if (!target) return false;
		if (event.y !== target.row || event.x < target.startColumn || event.x >= target.endColumn) return false;

		this.host.toggleVoiceLanguage();
		return true;
	}

	private handleInputClick(event: MouseEvent): boolean {
		const columns = this.host.terminalColumns();
		const terminalRows = this.host.terminalRows();
		const tabPanelRows = this.host.tabPanelRows(terminalRows);
		const rows = editorLayoutRows(terminalRows, tabPanelRows);
		const localY = event.y - editorLayoutTopOffset(tabPanelRows);
		const { renderedInput, inputStartRow } = this.host.editorLayoutRenderer().computeLayout(columns, rows);
		const inputEndRow = inputStartRow + renderedInput.lines.length;
		if (localY < inputStartRow || localY >= inputEndRow) return false;
		if (localY < inputStartRow + renderedInput.editorStartRowOffset) return false;

		const visibleRowOffset = localY - inputStartRow - renderedInput.editorStartRowOffset;
		const visualRow = renderedInput.scrollOffset + visibleRowOffset;
		const { left, contentWidth } = horizontalPaddingLayout(columns);
		const cursor = this.host.inputEditor().offsetAtVisualPosition(visualRow, event.x - left, contentWidth, "", "");
		this.host.resetRequestHistoryNavigation();
		this.host.inputEditor().setCursor(cursor, { preserveScroll: true });
		this.host.render();
		return true;
	}

	private handleExtensionInputClick(event: MouseEvent): boolean {
		const columns = this.host.terminalColumns();
		const terminalRows = this.host.terminalRows();
		const tabPanelRows = this.host.tabPanelRows(terminalRows);
		const rows = editorLayoutRows(terminalRows, tabPanelRows);
		const localY = event.y - editorLayoutTopOffset(tabPanelRows);
		const { renderedInput, inputStartRow } = this.host.editorLayoutRenderer().computeLayout(columns, rows);
		const inputEndRow = inputStartRow + renderedInput.editorStartRowOffset;
		if (localY < inputStartRow || localY >= inputEndRow) return false;

		const { left, contentWidth } = horizontalPaddingLayout(columns);
		return this.host.handleExtensionInputMouse({
			...event,
			localRow: localY - inputStartRow,
			localColumn: event.x - left,
			width: contentWidth,
		});
	}

	private openUserMessageMenu(entryId: string): void {
		if (!this.popupMenus.openUserMessageMenu(entryId)) return;
		this.host.render();
	}

	private openQueueMessageMenu(entryId: string): void {
		if (!this.popupMenus.openQueueMessageMenu(entryId)) return;
		this.host.render();
	}

	private copyErrorToast(toastId: number): boolean {
		const toast = this.host.toastEntry(toastId);
		if (toast?.kind !== "error") return false;

		try {
			this.copyTextToClipboard(toast.message);
			this.host.dismissToast(toastId);
			this.host.showToast("Error copied to clipboard", "success");
		} catch (error) {
			this.host.showToast(`Copy failed: ${stringifyUnknown(error)}`, "error");
		}
		return true;
	}

	private handleMouseSelection(event: MouseEvent): boolean {
		const baseButton = event.button & 3;
		const draggingLeftButton = (event.button & 32) !== 0 && baseButton === 0;

		if (event.released) {
			if (!this.mouseSelection) return false;
			this.cancelLeftEdgeReleaseFallback();
			this.updateSelectionCurrentFromMouse(event, { autoScroll: false });
			return this.finishMouseSelection();
		}

		if (draggingLeftButton) {
			if (!this.mouseSelection) return false;
			this.updateSelectionCurrentFromMouse(event);
			this.updateLeftEdgeReleaseFallback(event);
			this.host.render();
			return true;
		}

		if (event.button === 0) {
			this.cancelLeftEdgeReleaseFallback();
			this.stopAutoScroll();
			const point = { x: event.x, y: event.y };
			const conversationPoint = this.conversationPointFromMouse(event, false);
			this.mouseSelection = conversationPoint
				? {
					anchor: conversationPoint.screen,
					current: conversationPoint.screen,
					moved: false,
					kind: "conversation",
					conversationAnchor: conversationPoint.conversation,
					conversationCurrent: conversationPoint.conversation,
				}
				: { anchor: point, current: point, moved: false, kind: "screen" };
			return true;
		}

		return false;
	}

	private finishMouseSelection(): boolean {
		const selection = this.mouseSelection;
		if (!selection) return false;

		this.cancelLeftEdgeReleaseFallback();
		this.stopAutoScroll();
		this.mouseSelection = undefined;

		if (!selection.moved && samePoint(selection.anchor, selection.current)) {
			this.host.render();
			return false;
		}

		const selectedText = this.getSelectedText(selection);
		this.host.render();
		if (selectedText.trim().length === 0) return true;

		try {
			this.copyTextToClipboard(selectedText);
			this.host.showToast("Copied to clipboard", "success");
		} catch (error) {
			this.host.showToast(`Copy failed: ${stringifyUnknown(error)}`, "error");
		}
		return true;
	}

	private updateLeftEdgeReleaseFallback(event: MouseEvent): void {
		if (!this.mouseSelection?.moved || event.x > 1) {
			this.cancelLeftEdgeReleaseFallback();
			return;
		}

		this.cancelLeftEdgeReleaseFallback();
		this.leftEdgeReleaseFallbackTimer = setTimeout(() => {
			this.leftEdgeReleaseFallbackTimer = undefined;
			this.finishMouseSelection();
		}, LOST_MOUSE_RELEASE_SETTLE_MS);
	}

	private cancelLeftEdgeReleaseFallback(): void {
		if (!this.leftEdgeReleaseFallbackTimer) return;
		clearTimeout(this.leftEdgeReleaseFallbackTimer);
		this.leftEdgeReleaseFallbackTimer = undefined;
	}

	syncConversationSelectionForRender(startLine: number, bodyHeight: number, topReservedRows: number, width: number): void {
		this.renderedConversationFrame = {
			bodyHeight,
			topRow: topReservedRows + 1,
			viewportColumns: width,
		};

		const selection = this.mouseSelection;
		if (selection?.kind !== "conversation" || !selection.conversationAnchor || !selection.conversationCurrent) return;

		const range = orderedConversationSelection(selection.conversationAnchor, selection.conversationCurrent);
		const visibleStartLine = Math.max(range.start.line, startLine);
		const visibleEndLine = Math.min(range.end.line, startLine + Math.max(0, bodyHeight - 1));
		if (visibleEndLine < visibleStartLine) {
			selection.screenAnchor = { x: 1, y: 0 };
			selection.screenCurrent = { x: 1, y: 0 };
			return;
		}

		const startX = visibleStartLine === range.start.line ? range.start.x : 1;
		const endX = visibleEndLine === range.end.line ? range.end.x : width + 1;
		selection.screenAnchor = {
			x: Math.max(1, Math.min(width + 1, startX)),
			y: topReservedRows + (visibleStartLine - startLine) + 1,
		};
		selection.screenCurrent = {
			x: Math.max(1, Math.min(width + 1, endX)),
			y: topReservedRows + (visibleEndLine - startLine) + 1,
		};
	}

	private updateSelectionCurrentFromMouse(event: MouseEvent, options: { autoScroll?: boolean } = {}): void {
		const selection = this.mouseSelection;
		if (!selection) return;

		if (selection.kind === "conversation") {
			const conversationPoint = this.conversationPointFromMouse(event, true);
			if (!conversationPoint) return;
			selection.current = conversationPoint.screen;
			selection.conversationCurrent = conversationPoint.conversation;
			selection.moved = selection.moved
				|| !samePoint(selection.anchor, conversationPoint.screen)
				|| !sameConversationPoint(selection.conversationAnchor, conversationPoint.conversation);
			if (options.autoScroll ?? true) this.updateAutoScroll(event);
			return;
		}

		selection.current = { x: event.x, y: event.y };
		selection.moved = selection.moved || !samePoint(selection.anchor, selection.current);
		this.stopAutoScroll();
	}

	private getSelectedText(selection: MouseSelection): string {
		if (selection.kind === "conversation" && selection.conversationAnchor && selection.conversationCurrent) {
			return this.getSelectedConversationText(selection.conversationAnchor, selection.conversationCurrent);
		}

		return this.getSelectedScreenText(selection.anchor, selection.current);
	}

	private copyTextToClipboard(text: string): void {
		void Promise.resolve((this.host.copyTextToClipboard ?? copyTextToClipboard)(text)).catch((error) => {
			this.host.showToast(error instanceof Error ? error.message : String(error), "error");
		});
	}

	private getSelectedScreenText(anchor: ScreenPoint, current: ScreenPoint): string {
		const range = orderedSelection(anchor, current);
		const inputFrame = this.inputFrameCopyRows();
		const lines: string[] = [];

		for (let row = range.start.y; row <= range.end.y; row += 1) {
			const text = this.renderedRowTexts.get(row) ?? "";
			const startColumn = row === range.start.y ? range.start.x : 1;
			const endColumn = row === range.end.y ? range.end.x : text.length + 1;
			const selectedLine = screenSelectionLineText(row, text, startColumn, endColumn, inputFrame);
			if (selectedLine !== undefined) lines.push(selectedLine.trimEnd());
		}

		return lines.join("\n").replace(/\s+$/u, "");
	}

	private inputFrameCopyRows(): InputFrameCopyRows | undefined {
		const columns = this.host.terminalColumns();
		const terminalRows = this.host.terminalRows();
		const tabPanelRows = this.host.tabPanelRows(terminalRows);
		const rows = editorLayoutRows(terminalRows, tabPanelRows);
		const layout = this.host.editorLayoutRenderer().computeLayout(columns, rows);
		const topOffset = editorLayoutTopOffset(tabPanelRows);
		const toScreenRow = (layoutRow: number) => Math.max(1, Math.min(terminalRows, topOffset + layoutRow));
		const toScreenRowExclusive = (layoutRow: number) => Math.max(1, Math.min(terminalRows + 1, topOffset + layoutRow));

		return {
			inputStartRow: toScreenRow(layout.inputStartRow),
			inputEndRow: toScreenRowExclusive(layout.inputStartRow + layout.renderedInput.lines.length),
			inputSeparatorRow: toScreenRow(layout.inputSeparatorRow),
			inputBottomSeparatorRow: toScreenRow(layout.inputBottomSeparatorRow),
			contentStartColumn: 2,
			contentEndColumn: columns,
		};
	}

	private getSelectedConversationText(anchor: ConversationSelectionPoint, current: ConversationSelectionPoint): string {
		const range = orderedConversationSelection(anchor, current);
		const width = this.conversationArea()?.viewportColumns ?? this.host.terminalColumns();
		const count = range.end.line - range.start.line + 1;
		const renderedLines = this.host.conversationViewport().slice(width, range.start.line, count);
		const lines: string[] = [];

		for (let index = 0; index < count; index += 1) {
			const text = renderedLines[index]?.text ?? "";
			const line = range.start.line + index;
			const startColumn = line === range.start.line ? range.start.x : 1;
			const endColumn = line === range.end.line ? range.end.x : text.length + 1;
			lines.push(sliceByDisplayColumns(text, startColumn, endColumn).trimEnd());
		}

		return lines.join("\n").replace(/\s+$/u, "");
	}

	private conversationPointFromMouse(event: MouseEvent, clampToViewport: boolean): { conversation: ConversationSelectionPoint; screen: ScreenPoint } | undefined {
		const area = this.conversationArea();
		if (!area || area.bodyHeight <= 0) return undefined;
		if (!clampToViewport && (event.y < area.topRow || event.y > area.bottomRow)) return undefined;

		const screenY = Math.max(area.topRow, Math.min(area.bottomRow, event.y));
		const screenX = viewportSelectionColumn(event.x, area.viewportColumns);
		return {
			conversation: {
				line: area.metrics.start + (screenY - area.topRow),
				x: screenX,
			},
			screen: { x: screenX, y: screenY },
		};
	}

	private conversationArea(): {
		bodyHeight: number;
		bottomRow: number;
		metrics: ReturnType<AppScrollController["scrollMetrics"]>;
		topRow: number;
		viewportColumns: number;
	} | undefined {
		const columns = this.host.terminalColumns();
		const frame = this.renderedConversationFrame ?? this.computeConversationFrame(columns);
		if (!frame) return undefined;

		const { bodyHeight, topRow } = frame;
		if (columns <= 0 || bodyHeight <= 0) return undefined;

		const metrics = this.scrollController.scrollMetrics(columns, bodyHeight);
		const viewportColumns = Math.max(1, Math.min(columns, frame.viewportColumns, metrics.viewportColumns));
		return {
			bodyHeight,
			bottomRow: topRow + bodyHeight - 1,
			metrics,
			topRow,
			viewportColumns,
		};
	}

	private computeConversationFrame(columns: number): { bodyHeight: number; topRow: number; viewportColumns: number } | undefined {
		const terminalRows = this.host.terminalRows();
		const tabPanelRows = this.host.tabPanelRows(terminalRows);
		const rows = editorLayoutRows(terminalRows, tabPanelRows);
		const { bodyHeight } = this.host.editorLayoutRenderer().computeLayout(columns, rows);
		if (bodyHeight <= 0) return undefined;

		const metrics = this.scrollController.scrollMetrics(columns, bodyHeight);
		return {
			bodyHeight,
			topRow: editorLayoutTopOffset(tabPanelRows) + 1,
			viewportColumns: metrics.viewportColumns,
		};
	}

	private updateAutoScroll(event: MouseEvent): void {
		const area = this.conversationArea();
		if (!area) {
			this.stopAutoScroll();
			return;
		}

		this.autoScrollCursorX = event.x;
		if (event.y < area.topRow) {
			this.startAutoScroll(-1, area.topRow - event.y);
			return;
		}
		if (event.y > area.bottomRow) {
			this.startAutoScroll(1, event.y - area.bottomRow);
			return;
		}

		this.stopAutoScroll();
	}

	private startAutoScroll(direction: -1 | 1, distance: number): void {
		this.autoScrollDirection = direction;
		this.autoScrollDistance = Math.max(1, distance);
		if (this.autoScrollTimer) return;

		this.autoScrollAccumulator = 0;
		this.autoScrollLastTick = Date.now();
		this.autoScrollTimer = setInterval(() => this.tickAutoScroll(), 16);
	}

	private stopAutoScroll(): void {
		if (this.autoScrollTimer) clearInterval(this.autoScrollTimer);
		this.autoScrollTimer = undefined;
		this.autoScrollDirection = undefined;
		this.autoScrollDistance = 0;
		this.autoScrollAccumulator = 0;
		this.autoScrollLastTick = 0;
	}

	private tickAutoScroll(): void {
		if (this.mouseSelection?.kind !== "conversation" || !this.autoScrollDirection) {
			this.stopAutoScroll();
			return;
		}

		const now = Date.now();
		const elapsedSeconds = Math.max(0.001, Math.min(0.08, (now - this.autoScrollLastTick) / 1000));
		this.autoScrollLastTick = now;
		const linesPerSecond = Math.min(48, 8 + this.autoScrollDistance * 7);
		this.autoScrollAccumulator += this.autoScrollDirection * linesPerSecond * elapsedSeconds;
		const delta = Math.trunc(this.autoScrollAccumulator);
		if (delta === 0) return;

		this.autoScrollAccumulator -= delta;
		const scrolled = this.scrollController.scrollByLines(delta, { render: false });
		this.updateConversationSelectionAtAutoScrollEdge();
		if (scrolled) this.host.render();
	}

	private updateConversationSelectionAtAutoScrollEdge(): void {
		const selection = this.mouseSelection;
		if (selection?.kind !== "conversation" || !this.autoScrollDirection) return;
		const area = this.conversationArea();
		if (!area) return;

		const screenY = this.autoScrollDirection < 0 ? area.topRow : area.bottomRow;
		const screenX = viewportSelectionColumn(this.autoScrollCursorX, area.viewportColumns);
		selection.current = { x: screenX, y: screenY };
		selection.conversationCurrent = {
			line: area.metrics.start + (screenY - area.topRow),
			x: screenX,
		};
		selection.moved = true;
	}
}

function orderedConversationSelection(anchor: ConversationSelectionPoint, current: ConversationSelectionPoint): { start: ConversationSelectionPoint; end: ConversationSelectionPoint } {
	if (anchor.line < current.line) return { start: anchor, end: current };
	if (anchor.line > current.line) return { start: current, end: anchor };
	return anchor.x <= current.x ? { start: anchor, end: current } : { start: current, end: anchor };
}

export function screenSelectionLineText(
	row: number,
	text: string,
	startColumn: number,
	endColumn: number,
	inputFrame: InputFrameCopyRows | undefined,
): string | undefined {
	if (inputFrame && (row === inputFrame.inputSeparatorRow || row === inputFrame.inputBottomSeparatorRow)) {
		return undefined;
	}

	let copyStartColumn = startColumn;
	let copyEndColumn = endColumn;
	if (inputFrame && row >= inputFrame.inputStartRow && row < inputFrame.inputEndRow) {
		copyStartColumn = Math.max(copyStartColumn, inputFrame.contentStartColumn);
		copyEndColumn = Math.min(copyEndColumn, inputFrame.contentEndColumn);
	}

	return sliceByDisplayColumns(text, copyStartColumn, copyEndColumn);
}

function sameConversationPoint(left: ConversationSelectionPoint | undefined, right: ConversationSelectionPoint): boolean {
	return !!left && left.line === right.line && left.x === right.x;
}

function viewportSelectionColumn(mouseX: number, viewportColumns: number): number {
	if (mouseX >= viewportColumns) return viewportColumns + 1;
	return Math.max(1, Math.min(viewportColumns + 1, mouseX));
}

function toastTargetContainsEvent(target: Extract<NonNullable<RenderedLine["target"]>, { kind: "toast" }>, event: MouseEvent): boolean {
	if (target.startColumn === undefined || target.endColumn === undefined) return true;
	return event.x >= target.startColumn && event.x < target.endColumn;
}

function displayCellsInColumnRange(text: string, startColumn: number, endColumn: number): string {
	let cells = "";
	for (let column = startColumn; column < endColumn; column += 1) {
		cells += displayCellAtColumn(text, column);
	}
	return cells;
}

function nonBlankLineBounds(text: string, fallbackColumn: number): { startColumn: number; endColumn: number } {
	let startColumn: number | undefined;
	let endColumn: number | undefined;
	let displayColumn = 1;

	for (let index = 0; index < text.length;) {
		const codePoint = text.codePointAt(index) ?? 0;
		const char = String.fromCodePoint(codePoint);
		const width = stringDisplayWidth(char);
		index += char.length;

		if (width <= 0) continue;
		if (/\S/u.test(char)) {
			startColumn ??= displayColumn;
			endColumn = displayColumn + width;
		}
		displayColumn += width;
	}

	return startColumn === undefined || endColumn === undefined
		? { startColumn: fallbackColumn, endColumn: fallbackColumn + 1 }
		: { startColumn, endColumn };
}

function displayCellAtColumn(text: string, column: number): string {
	if (column < 1) return " ";

	let displayColumn = 1;
	for (let index = 0; index < text.length;) {
		const codePoint = text.codePointAt(index) ?? 0;
		const char = String.fromCodePoint(codePoint);
		const width = stringDisplayWidth(char);
		index += char.length;

		if (width <= 0) continue;
		if (column >= displayColumn && column < displayColumn + width) return width === 1 ? char : " ";
		displayColumn += width;
	}

	return " ";
}

function isModifiedPrimaryButton(button: number): boolean {
	const primaryButton = (button & 3) === 0;
	const modifierBits = button & (8 | 16);
	return primaryButton && modifierBits !== 0;
}

function editorLayoutRows(terminalRows: number, tabPanelRows: number): number {
	return Math.max(1, terminalRows - tabPanelRows);
}

function editorLayoutTopOffset(tabPanelRows: number): number {
	return tabPanelRows;
}
