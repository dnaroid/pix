import { FileMentionSearch } from "../../../src/file-mention-search";
import { fileMentionQuery, insertFileMention, type FileMentionMatch } from "../../../src/file-mentions";

interface Options {
  text: () => string;
  selectionStart: () => number;
  selectionEnd: () => number;
  context: () => string;
  enabled: () => boolean;
  request: (query: string, signal: AbortSignal) => Promise<FileMentionMatch[]>;
  replace: (text: string, cursor: number) => Promise<void>;
  dismissAutocomplete: () => void;
  closeMenu: () => void;
}

export function createPromptComposerMentionsController(options: Options) {
  let matches = $state<FileMentionMatch[]>([]);
  let selectedIndex = $state(0);
  let loading = $state(false);
  let failed = $state(false);
  let dismissed = $state("");
  const key = $derived(`${options.context()}\0${options.text()}\0${options.selectionStart()}\0${options.selectionEnd()}`);
  const query = $derived(options.enabled() && dismissed !== key
    ? fileMentionQuery(options.text(), options.selectionStart(), options.selectionEnd()) : undefined);
  const search = new FileMentionSearch((value, signal) => options.request(value, signal), (items, pending, error) => {
    matches = items; loading = pending; failed = error; selectedIndex = 0;
  });
  $effect(() => {
    search.observe(query ? key : "", query?.query ?? "");
    if (query) { options.dismissAutocomplete(); options.closeMenu(); }
  });
  $effect(() => () => search.dispose());

  function dismiss(): void { dismissed = key; search.dispose(); }
  async function accept(match: FileMentionMatch): Promise<void> {
    if (!query || !matches.includes(match)) return;
    const insertion = insertFileMention(options.text(), query, match.path);
    dismiss();
    await options.replace(insertion.text, insertion.cursor);
  }
  function handleKeydown(event: KeyboardEvent): boolean {
    if (!query || event.isComposing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return false;
    event.preventDefault();
    if (event.key === "Escape") dismiss();
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (matches.length) selectedIndex = (selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
    } else {
      const match = matches[selectedIndex];
      if (match) void accept(match);
    }
    // Never submit a half-typed mention while a request is still pending/empty.
    return true;
  }
  return {
    get open() { return !!query; }, get matches() { return matches; },
    get selectedIndex() { return selectedIndex; }, get loading() { return loading; }, get failed() { return failed; },
    select(index: number) { selectedIndex = index; }, dismiss, accept, handleKeydown,
  };
}
