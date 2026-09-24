import { tick } from "svelte";
import { findTextMatches, type TextSearchMatch } from "../lib/file-search";

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

const SEARCH_HIGHLIGHT = "pix-preview-search";
const ACTIVE_SEARCH_HIGHLIGHT = "pix-preview-search-active";

function cssHighlightRegistry(): HighlightRegistry | undefined {
  return (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
}

function highlightConstructor(): (new (...ranges: Range[]) => unknown) | undefined {
  return (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
}

function collectTextNodes(root: HTMLElement): { text: string; spans: TextNodeSpan[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spans: TextNodeSpan[] = [];
  let text = "";
  let node = walker.nextNode();
  while (node) {
    if (node instanceof Text) {
      const start = text.length;
      text += node.data;
      spans.push({ node, start, end: text.length });
    }
    node = walker.nextNode();
  }
  return { text, spans };
}

function rangeForMatch(spans: readonly TextNodeSpan[], match: TextSearchMatch): Range | undefined {
  const startSpan = spans.find((span) => match.start >= span.start && match.start < span.end);
  const endSpan = spans.find((span) => match.end > span.start && match.end <= span.end);
  if (!startSpan || !endSpan) return undefined;
  const range = document.createRange();
  range.setStart(startSpan.node, match.start - startSpan.start);
  range.setEnd(endSpan.node, match.end - endSpan.start);
  return range;
}

export function createPreviewFileSearchController(options: PreviewFileSearchOptions) {
  const state = $state({
    open: false,
    query: "",
    activeIndex: 0,
    matchCount: 0,
  });
  let observedPreviewId: number | undefined;
  let refreshGeneration = 0;
  let fallbackSelectionRange: Range | undefined;
  let editorSearchSelection:
    | { element: HTMLTextAreaElement; start: number; end: number }
    | undefined;

  function sameRange(left: Range, right: Range): boolean {
    return left.startContainer === right.startContainer
      && left.startOffset === right.startOffset
      && left.endContainer === right.endContainer
      && left.endOffset === right.endOffset;
  }

  function clearSearchDecorations(): void {
    const registry = cssHighlightRegistry();
    registry?.delete(SEARCH_HIGHLIGHT);
    registry?.delete(ACTIVE_SEARCH_HIGHLIGHT);

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

  function revealEditorMatch(matches: readonly TextSearchMatch[]): void {
    const editor = options.editorElement();
    const match = matches[state.activeIndex];
    if (!editor || !match) return;
    editor.setSelectionRange(match.start, match.end);
    editorSearchSelection = { element: editor, start: match.start, end: match.end };
    const lineIndex = options.fileText().slice(0, match.start).split("\n").length - 1;
    editor.scrollTop = Math.max(0, lineIndex * 24 - editor.clientHeight / 2);
  }

  function renderDomMatches(root: HTMLElement): void {
    const { text, spans } = collectTextNodes(root);
    const matches = findTextMatches(text, state.query);
    const ranges = matches.flatMap((match) => {
      const range = rangeForMatch(spans, match);
      return range ? [range] : [];
    });
    state.matchCount = ranges.length;
    state.activeIndex = ranges.length === 0
      ? 0
      : Math.min(state.activeIndex, ranges.length - 1);
    clearSearchDecorations();
    const activeRange = ranges[state.activeIndex];
    if (!activeRange) return;

    const registry = cssHighlightRegistry();
    const HighlightConstructor = highlightConstructor();
    if (registry && HighlightConstructor) {
      registry.set(SEARCH_HIGHLIGHT, new HighlightConstructor(...ranges));
      registry.set(ACTIVE_SEARCH_HIGHLIGHT, new HighlightConstructor(activeRange));
    } else {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(activeRange);
      fallbackSelectionRange = activeRange;
    }
    revealRange(activeRange);
  }

  function refresh(): void {
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
      clearSearchDecorations();
      const matches = findTextMatches(options.fileText(), state.query);
      state.matchCount = matches.length;
      state.activeIndex = matches.length === 0
        ? 0
        : Math.min(state.activeIndex, matches.length - 1);
      revealEditorMatch(matches);
      return;
    }
    const root = options.contentElement();
    if (!root) {
      state.matchCount = 0;
      clearSearchDecorations();
      return;
    }
    renderDomMatches(root);
  }

  function scheduleRefresh(): void {
    const generation = ++refreshGeneration;
    void tick().then(() => {
      if (generation === refreshGeneration) refresh();
    });
  }

  function open(): void {
    if (!options.enabled()) return;
    state.open = true;
    void tick().then(() => {
      options.inputElement()?.focus();
      options.inputElement()?.select();
      scheduleRefresh();
    });
  }

  function close(): void {
    refreshGeneration += 1;
    state.open = false;
    state.matchCount = 0;
    state.activeIndex = 0;
    clearSearchDecorations();
  }

  function setQuery(query: string): void {
    state.query = query;
    state.activeIndex = 0;
    if (!query.trim()) {
      refreshGeneration += 1;
      state.matchCount = 0;
      clearSearchDecorations();
      return;
    }
    scheduleRefresh();
  }

  function move(delta: number): void {
    if (state.matchCount <= 0) return;
    state.activeIndex = (state.activeIndex + delta + state.matchCount) % state.matchCount;
    scheduleRefresh();
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
    if (state.open) scheduleRefresh();
  });

  function dispose(): void {
    refreshGeneration += 1;
    clearSearchDecorations();
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
