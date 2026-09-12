import { tick } from "svelte";

const BOTTOM_THRESHOLD_PX = 24;

type TranscriptScrollOptions = {
  activeSessionId: () => string | null;
  pane: () => HTMLDivElement | null;
  content: () => HTMLDivElement | null;
};

export function createTranscriptScrollController(options: TranscriptScrollOptions) {
  let followsLatest = $state(true);
  let frame = 0;

  function isNearBottom(): boolean {
    const pane = options.pane();
    if (!pane) return true;
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= BOTTOM_THRESHOLD_PX;
  }

  function handleScroll(): void {
    followsLatest = isNearBottom();
  }

  function jumpToLatest(): void {
    followsLatest = true;
    scheduleScrollToLatest();
  }

  function scheduleScrollToLatest(): void {
    if (!followsLatest) return;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!followsLatest) return;
      const pane = options.pane();
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
  }

  async function scrollToLatest(): Promise<void> {
    if (!followsLatest) return;
    await tick();
    if (!followsLatest) return;
    const pane = options.pane();
    if (pane) pane.scrollTop = pane.scrollHeight;
  }

  function scrollToEntry(entryId: string): void {
    const target = options.pane()?.querySelector<HTMLElement>(
      `[data-transcript-entry-id="${CSS.escape(entryId)}"]`,
    );
    if (!target) return;
    followsLatest = false;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  $effect(() => {
    const sessionId = options.activeSessionId();
    const activeFrame = requestAnimationFrame(() => {
      if (sessionId !== options.activeSessionId()) return;
      followsLatest = true;
      scheduleScrollToLatest();
    });
    return () => cancelAnimationFrame(activeFrame);
  });

  $effect(() => {
    const pane = options.pane();
    const content = options.content();
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followsLatest) scheduleScrollToLatest();
    });
    observer.observe(pane);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  });

  function dispose(): void {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
  }

  return {
    get followsLatest() { return followsLatest; },
    handleScroll,
    jumpToLatest,
    scheduleScrollToLatest,
    scrollToLatest,
    scrollToEntry,
    dispose,
  };
}
