import { tick } from "svelte";
import type { PreviewScrollPosition } from "../lib/preview-history";
import type { ProjectFileLineRange, ProjectFilePreview } from "../lib/project-files";
import type { HighlightedCode } from "../lib/syntax-highlight";

interface PreviewScrollControllerOptions {
  readonly previewId: () => number;
  readonly scrollPosition: () => PreviewScrollPosition;
  readonly lineRange: () => ProjectFileLineRange | undefined;
  readonly searchRange?: () => ProjectFileLineRange | undefined;
  readonly file: () => ProjectFilePreview | undefined;
  readonly highlighted: () => HighlightedCode | undefined;
  readonly element: () => HTMLDivElement | undefined;
  readonly editing: () => boolean;
  readonly onBack: () => (() => void) | undefined;
  readonly onForward: () => (() => void) | undefined;
  readonly onScrollPositionChange: () => ((id: number, position: PreviewScrollPosition) => void) | undefined;
}

type AnimationFrameScheduler = (callback: FrameRequestCallback) => number;
type AnimationFrameCanceller = (handle: number) => void;

/** Source annotations keep semantic/Markdown matches navigable without flattening the DOM. */
export function renderedRangeElements(root: HTMLElement, range: ProjectFileLineRange): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-source-start-line]")).filter(element => {
    const start = Number(element.dataset.sourceStartLine);
    const end = Number(element.dataset.sourceEndLine);
    return start <= range.endLine && end >= range.startLine;
  });
}

/**
 * Run work one paint after scroll restoration. `restoreScroll` also uses an
 * animation frame, so a single frame can race it and have its line reveal
 * reset back to the saved position.
 */
export function scheduleAfterScrollRestore(
  callback: () => void,
  requestFrame: AnimationFrameScheduler = requestAnimationFrame,
  cancelFrame: AnimationFrameCanceller = cancelAnimationFrame,
): () => void {
  let firstFrame = 0;
  let secondFrame = 0;
  let cancelled = false;

  firstFrame = requestFrame(() => {
    firstFrame = 0;
    if (cancelled) return;
    secondFrame = requestFrame(() => {
      secondFrame = 0;
      if (!cancelled) callback();
    });
  });

  return () => {
    cancelled = true;
    if (firstFrame) cancelFrame(firstFrame);
    if (secondFrame) cancelFrame(secondFrame);
  };
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
    const searchRange = options.searchRange?.();
    const range = options.lineRange() ?? searchRange;
    const scroll = options.element();
    const scrollPosition = options.scrollPosition();
    const reveal = Boolean(range && scrollPosition.left === 0 && scrollPosition.top === 0);
    if (!scroll || !options.file() || (!options.highlighted() && !searchRange)) return;

    let cancelled = false;
    let cancelReveal = () => {};
    // The source body is injected with {@html}; wait for Svelte's DOM flush and
    // then for the scroll-restoration frame plus one paint so its line boxes have
    // final geometry before selecting/revealing.
    void tick().then(() => {
      if (cancelled || options.previewId() !== requestedPreviewId) return;
      cancelReveal = scheduleAfterScrollRestore(() => {
        if (cancelled || options.previewId() !== requestedPreviewId) return;
        for (const element of scroll.querySelectorAll(".preview-range-highlight")) {
          element.classList.remove("preview-range-highlight");
        }
        if (!range) return;
        const lines = Array.from(scroll.querySelectorAll<HTMLElement>(".preview-code .sh__line"));
        const startIndex = Math.max(0, Math.min(lines.length - 1, range.startLine - 1));
        const endIndex = Math.max(startIndex, Math.min(lines.length - 1, range.endLine - 1));
        const targets = options.highlighted()
          ? lines.slice(startIndex, endIndex + 1)
          : renderedRangeElements(scroll, range);
        for (const element of targets) element.classList.add("preview-range-highlight");

        if (!reveal) return;
        const first = targets[0];
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
      cancelReveal();
    };
  });

  return {
    restoreScroll,
    remember,
    back,
    forward,
  };
}
