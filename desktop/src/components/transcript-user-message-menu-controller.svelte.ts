import { tick } from "svelte";
import { desktopContextTarget } from "../lib/desktop-context-target";
import { desktopCommandDefinition } from "../lib/desktop-commands";
import {
  isTypeaheadKey,
  menuFocusIndex,
  menuTypeaheadFocusIndex,
  type MenuNavigationItem,
} from "../lib/keyboard-navigation";
import type { MessageItem, TranscriptDisplayItem } from "../lib/transcript";

export type UserMessageAction = "copy" | "fork" | "fork-new-tab" | "undo";

interface TranscriptUserMessageMenuControllerOptions {
  readonly items: () => readonly TranscriptDisplayItem[];
  readonly activeSessionId: () => string | null;
  readonly promptRunning: () => boolean;
  readonly operationRunning: () => boolean;
  readonly historyLoading: () => boolean;
  readonly onScroll: () => void;
  readonly onAction: (message: MessageItem, action: UserMessageAction) => void | Promise<void>;
}

const MENU_WIDTH = 192;
const MENU_HEIGHT = 164;
const MENU_GAP = 6;
const MENU_MARGIN = 8;

export const userMessageMenuCommands = {
  copy: desktopCommandDefinition("message.copy"),
  fork: desktopCommandDefinition("message.fork"),
  forkNewTab: desktopCommandDefinition("message.forkNewTab"),
  undo: desktopCommandDefinition("message.undo"),
} as const;

export function createTranscriptUserMessageMenuController(options: TranscriptUserMessageMenuControllerOptions) {
  const state = $state({
    activeId: null as string | null,
    position: null as { left: number; top: number } | null,
    menuElement: null as HTMLDivElement | null,
  });
  let trigger: HTMLElement | null = null;
  let typeaheadQuery = "";
  let typeaheadTimer: number | null = null;

  function canMutate(): boolean {
    return Boolean(options.activeSessionId())
      && !options.promptRunning()
      && !options.operationRunning()
      && !options.historyLoading();
  }

  function activeMessage(): MessageItem | null {
    if (!state.activeId) return null;
    const item = options.items().find((candidate) => candidate.id === state.activeId);
    return item?.type === "message" && item.role === "user" ? item : null;
  }

  function close(restoreFocus = false): void {
    state.activeId = null;
    state.position = null;
    if (restoreFocus) trigger?.focus();
    trigger = null;
  }

  function navigationItems(): MenuNavigationItem[] {
    const mutationDisabled = !canMutate() || Boolean(activeMessage()?.localOnly);
    return [
      { label: userMessageMenuCommands.copy.label },
      { label: userMessageMenuCommands.fork.label, disabled: mutationDisabled },
      { label: userMessageMenuCommands.forkNewTab.label, disabled: mutationDisabled },
      { label: userMessageMenuCommands.undo.label, disabled: mutationDisabled },
    ];
  }

  function buttons(): HTMLButtonElement[] {
    return [...(state.menuElement?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
  }

  function focusItem(index: number): void {
    buttons()[index]?.focus();
  }

  function focusFirstItem(): void {
    void tick().then(() => {
      const firstIndex = menuFocusIndex(navigationItems(), -1, "ArrowDown");
      if (firstIndex !== null) focusItem(firstIndex);
    });
  }

  function handleMenuKeydown(event: KeyboardEvent): void {
    const menuButtons = buttons();
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[role='menuitem']")
      : null;
    const currentIndex = target ? menuButtons.indexOf(target) : -1;
    const items = navigationItems();

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }

    const nextIndex = menuFocusIndex(items, currentIndex, event.key);
    if (nextIndex !== null) {
      event.preventDefault();
      focusItem(nextIndex);
      return;
    }
    if (!isTypeaheadKey(event)) return;
    event.preventDefault();
    const key = event.key.toLocaleLowerCase();
    let query = typeaheadQuery.length === 1 && typeaheadQuery === key
      ? key
      : `${typeaheadQuery}${key}`;
    let typeaheadIndex = menuTypeaheadFocusIndex(items, currentIndex, query);
    if (typeaheadIndex === null && query.length > 1) {
      query = key;
      typeaheadIndex = menuTypeaheadFocusIndex(items, currentIndex, query);
    }
    typeaheadQuery = query;
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = window.setTimeout(() => {
      typeaheadQuery = "";
      typeaheadTimer = null;
    }, 700);
    if (typeaheadIndex !== null) focusItem(typeaheadIndex);
  }

  function position(anchorX: number, anchorTop: number, anchorBottom: number, alignRight: boolean): void {
    const maxLeft = window.innerWidth - MENU_WIDTH - MENU_MARGIN;
    const left = clampCoordinate(
      alignRight ? anchorX - MENU_WIDTH : anchorX,
      MENU_MARGIN,
      maxLeft,
    );
    const belowTop = anchorBottom + MENU_GAP;
    const aboveTop = anchorTop - MENU_GAP - MENU_HEIGHT;
    const top = belowTop + MENU_HEIGHT <= window.innerHeight - MENU_MARGIN
      ? belowTop
      : Math.max(MENU_MARGIN, aboveTop);
    state.position = { left, top };
  }

  function toggle(event: MouseEvent, messageId: string): void {
    event.preventDefault();
    event.stopPropagation();
    if (state.activeId === messageId) {
      close();
      return;
    }
    const nextTrigger = event.currentTarget as HTMLElement;
    const rect = nextTrigger.getBoundingClientRect();
    trigger = nextTrigger;
    state.activeId = messageId;
    position(rect.right, rect.top, rect.bottom, true);
    focusFirstItem();
  }

  function openContextMenu(event: MouseEvent, messageId: string): void {
    // Selected text/links have their own native menu. The ellipsis remains an
    // unconditional route to whole-message Copy/Fork/Undo actions.
    if (desktopContextTarget(event.target)) {
      close();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state.activeId = messageId;
    position(event.clientX, event.clientY, event.clientY, false);
    focusFirstItem();
  }

  function handleWindowClick(event: MouseEvent): void {
    if (!state.activeId) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("[data-user-message-menu]")) close();
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !state.activeId) return;
    event.preventDefault();
    close(true);
  }

  function handleWindowResize(): void {
    if (state.activeId) close();
  }

  function handlePaneScroll(): void {
    if (state.activeId) close();
    options.onScroll();
  }

  async function runAction(message: MessageItem, action: UserMessageAction): Promise<void> {
    if (action !== "copy" && !canMutate()) return;
    close();
    await options.onAction(message, action);
  }

  function dispose(): void {
    if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = null;
  }

  return {
    state,
    get canMutate() { return canMutate(); },
    get activeMessage() { return activeMessage(); },
    toggle,
    openContextMenu,
    handleMenuKeydown,
    handleWindowClick,
    handleWindowKeydown,
    handleWindowResize,
    handlePaneScroll,
    runAction,
    close,
    dispose,
  };
}

function clampCoordinate(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
