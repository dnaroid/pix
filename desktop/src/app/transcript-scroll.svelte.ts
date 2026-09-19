import { tick } from "svelte";

const BOTTOM_THRESHOLD_PX = 24;

type TranscriptScrollOptions = {
  activeSessionId: () => string | null;
  pane: () => HTMLDivElement | null;
  content: () => HTMLDivElement | null;
};

type ScrollMetrics = Pick<HTMLDivElement, "clientHeight" | "scrollHeight" | "scrollTop">;

export function reconcileTranscriptResize(
  followsLatest: boolean,
  pane: ScrollMetrics,
): { followsLatest: boolean; scrollToLatest: boolean } {
  // Preserve follow mode across content growth: the resize has already moved
  // the bottom, so recomputing from the old scrollTop would turn it off before
  // the scheduled scroll can catch up.
  if (followsLatest) return { followsLatest: true, scrollToLatest: true };

  // A collapsed tool block can clamp scrollTop to the bottom (including zero
  // when overflow disappears) without emitting a scroll event.
  const isNearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= BOTTOM_THRESHOLD_PX;
  return { followsLatest: isNearBottom, scrollToLatest: false };
}

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
    let connected = true;
    const observer = new ResizeObserver(() => {
      if (!connected || pane !== options.pane()) return;
      const reconciliation = reconcileTranscriptResize(followsLatest, pane);
      followsLatest = reconciliation.followsLatest;
      if (reconciliation.scrollToLatest) scheduleScrollToLatest();
    });
    observer.observe(pane);
    if (content) observer.observe(content);
    return () => {
      connected = false;
      observer.disconnect();
    };
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
