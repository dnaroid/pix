import { tick } from "svelte";
import type { PreviewScrollPosition } from "../lib/preview-history";
import type { ProjectFileLineRange, ProjectFilePreview } from "../lib/project-files";
import type { HighlightedCode } from "../lib/syntax-highlight";

interface PreviewScrollControllerOptions {
  readonly previewId: () => number;
  readonly scrollPosition: () => PreviewScrollPosition;
  readonly lineRange: () => ProjectFileLineRange | undefined;
  readonly file: () => ProjectFilePreview | undefined;
  readonly highlighted: () => HighlightedCode | undefined;
  readonly element: () => HTMLDivElement | undefined;
  readonly editing: () => boolean;
  readonly onBack: () => (() => void) | undefined;
  readonly onForward: () => (() => void) | undefined;
  readonly onScrollPositionChange: () => ((id: number, position: PreviewScrollPosition) => void) | undefined;
}

export function createPreviewScrollController(options: PreviewScrollControllerOptions) {
  function restoreScroll(
    node: HTMLElement,
    initial: { key: number; position: PreviewScrollPosition },
  ): { update: (next: { key: number; position: PreviewScrollPosition }) => void; destroy: () => void } {
    let key = initial.key;
    let frame = 0;

    function schedule(position: PreviewScrollPosition): void {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        node.scrollLeft = position.left;
        node.scrollTop = position.top;
      });
    }

    schedule(initial.position);
    return {
      update(next): void {
        if (next.key === key) return;
        key = next.key;
        schedule(next.position);
      },
      destroy(): void {
        cancelAnimationFrame(frame);
      },
    };
  }

  function remember(): void {
    const element = options.element();
    if (!element) return;
    options.onScrollPositionChange()?.(options.previewId(), {
      left: element.scrollLeft,
      top: element.scrollTop,
    });
  }

  function back(): void {
    if (options.editing()) return;
    remember();
    options.onBack()?.();
  }

  function forward(): void {
    if (options.editing()) return;
    remember();
    options.onForward()?.();
  }

  $effect(() => {
    const requestedPreviewId = options.previewId();
    const range = options.lineRange();
    const scroll = options.element();
    const scrollPosition = options.scrollPosition();
    const reveal = Boolean(range && scrollPosition.left === 0 && scrollPosition.top === 0);
    if (!scroll || !options.file() || !options.highlighted()) return;

    let cancelled = false;
    let frame = 0;
    // The source body is injected with {@html}; wait for Svelte's DOM flush and
    // then one frame so line boxes have final geometry before selecting/revealing.
    void tick().then(() => {
      if (cancelled || options.previewId() !== requestedPreviewId) return;
      frame = requestAnimationFrame(() => {
        if (cancelled || options.previewId() !== requestedPreviewId) return;
        const lines = Array.from(scroll.querySelectorAll<HTMLElement>(".preview-code .sh__line"));
        for (const line of lines) line.classList.remove("preview-range-highlight");
        if (!range || lines.length === 0) return;

        const startIndex = Math.max(0, Math.min(lines.length - 1, range.startLine - 1));
        const endIndex = Math.max(startIndex, Math.min(lines.length - 1, range.endLine - 1));
        for (let index = startIndex; index <= endIndex; index += 1) {
          lines[index]?.classList.add("preview-range-highlight");
        }

        if (!reveal) return;
        const first = lines[startIndex];
        if (!first) return;
        const scrollRect = scroll.getBoundingClientRect();
        const firstRect = first.getBoundingClientRect();
        const targetTop = scroll.scrollTop
          + firstRect.top
          - scrollRect.top
          - Math.max(24, (scroll.clientHeight - firstRect.height) * 0.35);
        scroll.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  });

  return {
    restoreScroll,
    remember,
    back,
    forward,
  };
}
