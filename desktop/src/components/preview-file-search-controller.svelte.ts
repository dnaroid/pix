import { tick } from "svelte";
import { findSpanIndex, findTextMatches, lineIndexAt, type TextSearchMatch } from "../lib/file-search";

type PreviewFileSearchOptions = {
  active: () => boolean;
  previewId: () => number;
  enabled: () => boolean;
  editing: () => boolean;
  fileText: () => string;
  contentElement: () => HTMLElement | undefined;
  editorElement: () => HTMLTextAreaElement | undefined;
  inputElement: () => HTMLInputElement | undefined;
};

type TextNodeSpan = {
  node: Text;
  start: number;
  end: number;
};

type HighlightRegistry = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => boolean;
};

/** Typing waits this long before searching; Enter/next/prev run immediately. */
export const PREVIEW_SEARCH_DEBOUNCE_MS = 100;
const SEARCH_HIGHLIGHT = "pix-preview-search";
const ACTIVE_SEARCH_HIGHLIGHT = "pix-preview-search-active";

function cssHighlightRegistry(): HighlightRegistry | undefined {
  return (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
}

function highlightConstructor(): (new (...ranges: Range[]) => unknown) | undefined {
  return (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
}

function collectTextNodes(root: HTMLElement): { text: string; spans: TextNodeSpan[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spans: TextNodeSpan[] = [];
  const parts: string[] = [];
  let length = 0;
  let node = walker.nextNode();
  while (node) {
    if (node instanceof Text) {
      const start = length;
      length += node.data.length;
      parts.push(node.data);
      spans.push({ node, start, end: length });
    }
    node = walker.nextNode();
  }
  return { text: parts.join(""), spans };
}

function rangeForMatch(spans: readonly TextNodeSpan[], match: TextSearchMatch): Range | undefined {
  const startSpan = spans[findSpanIndex(spans, match.start, "start")];
  const endSpan = spans[findSpanIndex(spans, match.end, "end")];
  if (!startSpan || !endSpan) return undefined;
  const range = document.createRange();
  range.setStart(startSpan.node, match.start - startSpan.start);
  range.setEnd(endSpan.node, match.end - endSpan.start);
  return range;
}

/** Matches for one query over one text snapshot; reused by Enter/next/prev. */
type SearchResult =
  | { kind: "editor"; query: string; text: string; matches: TextSearchMatch[] }
  | { kind: "dom"; query: string; root: HTMLElement; version: number; ranges: Range[] };

export function createPreviewFileSearchController(options: PreviewFileSearchOptions) {
  const state = $state({
    open: false,
    query: "",
    activeIndex: 0,
    matchCount: 0,
  });
  let observedPreviewId: number | undefined;
  let refreshGeneration = 0;
  let queryTimer: ReturnType<typeof setTimeout> | undefined;
  let result: SearchResult | undefined;
  let fallbackSelectionRange: Range | undefined;
  let editorSearchSelection:
    | { element: HTMLTextAreaElement; start: number; end: number }
    | undefined;
  // Rendered text is collected once per DOM version; a mutation observer marks
  // it stale, so next/prev and repeated queries skip the tree walk.
  let textIndex: { root: HTMLElement; version: number; text: string; spans: TextNodeSpan[] } | undefined;
  let observedRoot: HTMLElement | undefined;
  let domVersion = 0;
  let mutationObserver: MutationObserver | undefined;

  function observeRoot(root: HTMLElement): void {
    if (root === observedRoot) return;
    mutationObserver?.disconnect();
    mutationObserver = undefined;
    observedRoot = root;
    domVersion += 1;
    textIndex = undefined;
    if (typeof MutationObserver === "undefined") return;
    mutationObserver = new MutationObserver(() => {
      domVersion += 1;
      textIndex = undefined;
    });
    mutationObserver.observe(root, { childList: true, characterData: true, subtree: true });
  }

  function stopObserving(): void {
    mutationObserver?.disconnect();
    mutationObserver = undefined;
    observedRoot = undefined;
    textIndex = undefined;
    result = undefined;
  }

  function domText(root: HTMLElement): { text: string; spans: TextNodeSpan[]; version: number } {
    observeRoot(root);
    // Records not yet delivered still mean the cached text is stale. Without a
    // MutationObserver the DOM cannot be trusted between refreshes.
    if (!mutationObserver || mutationObserver.takeRecords().length > 0) domVersion += 1;
    if (textIndex?.root !== root || textIndex.version !== domVersion) {
      textIndex = { root, version: domVersion, ...collectTextNodes(root) };
    }
    return textIndex;
  }

  function sameRange(left: Range, right: Range): boolean {
    return left.startContainer === right.startContainer
      && left.startOffset === right.startOffset
      && left.endContainer === right.endContainer
      && left.endOffset === right.endOffset;
  }

  function clearDomHighlights(): void {
    const registry = cssHighlightRegistry();
    registry?.delete(SEARCH_HIGHLIGHT);
    registry?.delete(ACTIVE_SEARCH_HIGHLIGHT);
  }

  function clearSearchDecorations(): void {
    clearDomHighlights();

    if (fallbackSelectionRange) {
      const selection = window.getSelection();
      if (
        selection?.rangeCount === 1
        && sameRange(selection.getRangeAt(0), fallbackSelectionRange)
      ) {
        selection.removeAllRanges();
      }
      fallbackSelectionRange = undefined;
    }

    if (editorSearchSelection) {
      const { element, start, end } = editorSearchSelection;
      if (element.selectionStart === start && element.selectionEnd === end) {
        element.setSelectionRange(end, end);
      }
      editorSearchSelection = undefined;
    }
  }

  function revealRange(range: Range): void {
    const element = range.startContainer.parentElement;
    element?.scrollIntoView({ block: "center", inline: "nearest" });
  }

  function revealEditorMatch(text: string, matches: readonly TextSearchMatch[]): void {
    const editor = options.editorElement();
    const match = matches[state.activeIndex];
    if (!editor || !match) return;
    editor.setSelectionRange(match.start, match.end);
    editorSearchSelection = { element: editor, start: match.start, end: match.end };
    editor.scrollTop = Math.max(0, lineIndexAt(text, match.start) * 24 - editor.clientHeight / 2);
  }

  function clampActive(count: number): void {
    state.matchCount = count;
    state.activeIndex = count === 0 ? 0 : Math.min(state.activeIndex, count - 1);
  }

  function decorateDomMatches(ranges: readonly Range[], reveal: boolean): void {
    clearSearchDecorations();
    const activeRange = ranges[state.activeIndex];
    if (!activeRange) return;

    const registry = cssHighlightRegistry();
    const HighlightConstructor = highlightConstructor();
    if (registry && HighlightConstructor) {
      registry.set(SEARCH_HIGHLIGHT, new HighlightConstructor(...ranges));
      registry.set(ACTIVE_SEARCH_HIGHLIGHT, new HighlightConstructor(activeRange));
    } else if (reveal) {
      // The selection fallback is intrusive; apply it only on query/navigation.
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(activeRange);
      fallbackSelectionRange = activeRange;
    }
    if (reveal) revealRange(activeRange);
  }

  function renderDomMatches(root: HTMLElement, reveal: boolean): void {
    const index = domText(root);
    let ranges: Range[];
    if (result?.kind === "dom" && result.root === root && result.version === index.version
      && result.query === state.query) {
      ranges = result.ranges;
    } else {
      ranges = findTextMatches(index.text, state.query).flatMap((match) => {
        const range = rangeForMatch(index.spans, match);
        return range ? [range] : [];
      });
      result = { kind: "dom", query: state.query, root, version: index.version, ranges };
    }
    clampActive(ranges.length);
    decorateDomMatches(ranges, reveal);
  }

  /**
   * `reveal` moves the editor selection or scrolls to the active match. Only
   * query changes and explicit navigation reveal; content changes (typing in
   * the Preview editor, re-rendered Markdown) only recount and re-highlight.
   */
  function refresh(reveal: boolean): void {
    if (!state.open || !options.enabled()) {
      state.matchCount = 0;
      clearSearchDecorations();
      return;
    }
    if (!state.query.trim()) {
      state.matchCount = 0;
      state.activeIndex = 0;
      clearSearchDecorations();
      return;
    }
    if (options.editing()) {
      const text = options.fileText();
      let matches: TextSearchMatch[];
      if (result?.kind === "editor" && result.text === text && result.query === state.query) {
        matches = result.matches;
      } else {
        matches = findTextMatches(text, state.query);
        result = { kind: "editor", query: state.query, text, matches };
      }
      clampActive(matches.length);
      if (!reveal) {
        // Keep the user's caret: a draft edit must not jump to the match.
        clearDomHighlights();
        return;
      }
      clearSearchDecorations();
      revealEditorMatch(text, matches);
      return;
    }
    const root = options.contentElement();
    if (!root) {
      state.matchCount = 0;
      clearSearchDecorations();
      return;
    }
    renderDomMatches(root, reveal);
  }

  function cancelQueryTimer(): void {
    if (queryTimer !== undefined) clearTimeout(queryTimer);
    queryTimer = undefined;
  }

  function scheduleRefresh(reveal: boolean): void {
    const generation = ++refreshGeneration;
    void tick().then(() => {
      if (generation === refreshGeneration) refresh(reveal);
    });
  }

  function open(): void {
    if (!options.enabled()) return;
    state.open = true;
    void tick().then(() => {
      options.inputElement()?.focus();
      options.inputElement()?.select();
      scheduleRefresh(true);
    });
  }

  function close(): void {
    refreshGeneration += 1;
    cancelQueryTimer();
    state.open = false;
    state.matchCount = 0;
    state.activeIndex = 0;
    clearSearchDecorations();
    stopObserving();
  }

  function setQuery(query: string): void {
    state.query = query;
    state.activeIndex = 0;
    cancelQueryTimer();
    if (!query.trim()) {
      refreshGeneration += 1;
      state.matchCount = 0;
      clearSearchDecorations();
      return;
    }
    // The debounced query search supersedes any pending content refresh.
    const generation = ++refreshGeneration;
    queryTimer = setTimeout(() => {
      queryTimer = undefined;
      if (generation === refreshGeneration) refresh(true);
    }, PREVIEW_SEARCH_DEBOUNCE_MS);
  }

  function move(delta: number): void {
    if (queryTimer !== undefined) {
      // Enter before the debounce elapsed: search now and reveal the first match.
      cancelQueryTimer();
      refreshGeneration += 1;
      refresh(true);
      return;
    }
    if (state.matchCount <= 0) return;
    state.activeIndex = (state.activeIndex + delta + state.matchCount) % state.matchCount;
    scheduleRefresh(true);
  }

  function handleInputKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    }
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (!options.active() || !options.enabled()) return;
    const primary = (event.metaKey || event.ctrlKey) && !(event.metaKey && event.ctrlKey);
    if (
      primary
      && !event.shiftKey
      && !event.altKey
      && event.key.toLocaleLowerCase() === "f"
    ) {
      event.preventDefault();
      open();
    }
  }

  $effect(() => {
    const previewId = options.previewId();
    if (observedPreviewId === undefined) {
      observedPreviewId = previewId;
      return;
    }
    if (observedPreviewId === previewId) return;
    observedPreviewId = previewId;
    state.query = "";
    close();
  });

  $effect(() => {
    options.fileText();
    options.editing();
    options.contentElement();
    // Content changed: recount only. A pending debounced query still reveals.
    if (state.open && queryTimer === undefined) scheduleRefresh(false);
  });

  function dispose(): void {
    refreshGeneration += 1;
    cancelQueryTimer();
    clearSearchDecorations();
    stopObserving();
  }

  return {
    state,
    open,
    close,
    setQuery,
    previous: () => move(-1),
    next: () => move(1),
    handleInputKeydown,
    handleWindowKeydown,
    dispose,
  };
}
