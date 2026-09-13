import type { AvailableCommand } from "@agentclientprotocol/sdk";
import {
  matchSlashCommands,
  shouldSubmitAcceptedSlashCommand,
  slashCommandInsertion,
  slashCommandQuery,
  type SlashCommandMatch,
} from "../lib/slash-commands";

interface PromptComposerSlashControllerOptions {
  readonly promptText: () => string;
  readonly selectionStart: () => number;
  readonly selectionEnd: () => number;
  readonly availableCommands: () => readonly AvailableCommand[];
  readonly editorMode: () => boolean;
  readonly ready: () => boolean;
  readonly activeSessionId: () => string | null;
  readonly promptRunning: () => boolean;
  readonly questionMode: () => boolean;
  readonly composing: () => boolean;
  readonly attachmentsCount: () => number;
  readonly listbox: () => HTMLDivElement | undefined;
  readonly dismissAutocomplete: () => void;
  readonly closeComposerMenu: () => void;
  readonly replacePromptText: (value: string, cursor: number) => Promise<void>;
  readonly submit: () => void | Promise<void>;
}

export function createPromptComposerSlashController(options: PromptComposerSlashControllerOptions) {
  let selectedIndex = $state(0);
  let dismissedDraft = $state<string | null>(null);
  let menuKey = "";

  const query = $derived.by(() => {
    if (
      options.editorMode()
      || !options.ready()
      || !options.activeSessionId()
      || options.promptRunning()
      || options.questionMode()
      || options.composing()
      || options.attachmentsCount() > 0
    ) {
      return undefined;
    }
    const promptText = options.promptText();
    if (dismissedDraft === promptText) return undefined;
    return slashCommandQuery(promptText, options.selectionStart(), options.selectionEnd());
  });
  const matches = $derived.by(() => (
    query === undefined ? [] : matchSlashCommands(options.availableCommands(), query)
  ));
  const open = $derived(matches.length > 0);
  const activeMatch = $derived(matches[selectedIndex]);

  $effect(() => {
    const promptText = options.promptText();
    if (dismissedDraft !== null && dismissedDraft !== promptText) dismissedDraft = null;
  });

  $effect(() => {
    const key = query === undefined
      ? ""
      : `${query}\0${matches.map(({ command }) => command.name).join("\0")}`;
    if (key !== menuKey) {
      menuKey = key;
      selectedIndex = 0;
    } else if (selectedIndex >= matches.length) {
      selectedIndex = Math.max(0, matches.length - 1);
    }
    if (open) {
      options.dismissAutocomplete();
      options.closeComposerMenu();
    }
  });

  $effect(() => {
    const listbox = options.listbox();
    if (!open || !listbox) return;
    const index = selectedIndex;
    const frame = requestAnimationFrame(() => {
      listbox
        .querySelector<HTMLElement>(`[data-slash-command-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  });

  function clearDismissal(): void {
    dismissedDraft = null;
  }

  function dismissCurrent(): void {
    dismissedDraft = options.promptText();
  }

  function select(index: number): void {
    selectedIndex = index;
  }

  async function accept(match: SlashCommandMatch, submit: boolean): Promise<void> {
    const insertion = slashCommandInsertion(match.command);
    dismissedDraft = submit ? null : insertion;
    await options.replacePromptText(insertion, insertion.length);
    if (submit && shouldSubmitAcceptedSlashCommand(match)) await options.submit();
  }

  function handleKeydown(event: KeyboardEvent): boolean {
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      selectedIndex = (selectedIndex + direction + matches.length) % matches.length;
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      dismissCurrent();
      options.dismissAutocomplete();
      return true;
    }
    if (
      (event.key === "Tab" || event.key === "Enter")
      && !event.shiftKey
      && !event.ctrlKey
      && !event.altKey
      && !event.metaKey
      && !event.isComposing
      && activeMatch
    ) {
      event.preventDefault();
      void accept(activeMatch, event.key === "Enter");
      return true;
    }
    return false;
  }

  return {
    get query() { return query; },
    get matches() { return matches; },
    get open() { return open; },
    get selectedIndex() { return selectedIndex; },
    get activeMatch() { return activeMatch; },
    clearDismissal,
    dismissCurrent,
    select,
    accept,
    handleKeydown,
  };
}

export type PromptComposerSlashController = ReturnType<typeof createPromptComposerSlashController>;
