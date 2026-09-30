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
  // display:none has no useful scroll geometry. In particular, a hidden pane
  // must not make a reader who scrolled up appear to be at the bottom.
  if (pane.clientHeight === 0) return { followsLatest, scrollToLatest: false };
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
  let visible = true;
  let restorePending = false;
  let savedScrollTop = 0;
  let activatedSessionId: string | null | undefined;

  function isNearBottom(): boolean {
    const pane = options.pane();
    if (!pane) return true;
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= BOTTOM_THRESHOLD_PX;
  }

  function handleScroll(): void {
    if (!visible || restorePending || !options.pane()?.clientHeight) return;
    followsLatest = isNearBottom();
  }

  // Called before the workbench changes display:none, while the old pane still
  // has valid geometry. Ignore hide/show scroll events until restoration runs.
  function setVisible(nextVisible: boolean): void {
    if (visible === nextVisible) return;
    if (!nextVisible) {
      const pane = options.pane();
      if (!restorePending && pane?.clientHeight) savedScrollTop = pane.scrollTop;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
    visible = nextVisible;
    restorePending = true;
    if (visible) scheduleScrollToLatest();
  }

  // Session tabs share one pane. Arm restoration before replacing its content,
  // so scroll events caused by the outgoing transcript cannot stop following.
  function activateSession(sessionId: string | null): void {
    if (activatedSessionId === sessionId) return;
    activatedSessionId = sessionId;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    followsLatest = true;
    restorePending = true;
    scheduleScrollToLatest();
  }

  function jumpToLatest(): void {
    followsLatest = true;
    scheduleScrollToLatest();
  }

  function scheduleScrollToLatest(): void {
    // Coalesce stream/resize notifications without moving a pending scroll to
    // the next frame. Otherwise continuous updates can starve the live edge.
    if (!visible || (!followsLatest && !restorePending) || frame) return;
    const sessionId = options.activeSessionId();
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (sessionId !== options.activeSessionId()) return;
      if (!visible || (!followsLatest && !restorePending)) return;
      const pane = options.pane();
      // A show frame can run before layout is usable; ResizeObserver retries.
      if (!pane?.clientHeight) return;
      pane.scrollTop = followsLatest ? pane.scrollHeight : savedScrollTop;
      restorePending = false;
    });
  }

  async function scrollToLatest(): Promise<void> {
    // Calls to this method come from explicit user/application actions such as
    // sending a prompt. Those actions should bring the conversation back to the
    // live edge even when the user had previously scrolled up.
    followsLatest = true;
    await tick();
    const pane = options.pane();
    if (visible && pane?.clientHeight) {
      pane.scrollTop = pane.scrollHeight;
      restorePending = false;
    }
  }

  function scrollToEntry(entryId: string): void {
    const target = options.pane()?.querySelector<HTMLElement>(
      `[data-transcript-entry-id="${CSS.escape(entryId)}"]`,
    );
    if (!target) return;
    followsLatest = false;
    restorePending = false;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  $effect(() => {
    const pane = options.pane();
    const content = options.content();
    if (!pane || typeof ResizeObserver === "undefined") return;
    let connected = true;
    const observer = new ResizeObserver(() => {
      if (!connected || !visible || pane !== options.pane() || !pane.clientHeight) return;
      if (restorePending) {
        scheduleScrollToLatest();
        return;
      }
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
    activateSession,
    setVisible,
    handleScroll,
    jumpToLatest,
    scheduleScrollToLatest,
    scrollToLatest,
    scrollToEntry,
    dispose,
  };
}
