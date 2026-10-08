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
  let restorePending = $state(false);
  let savedScrollTop = 0;
  let activatedSessionId: string | null | undefined;
  let scrollRevision = 0;
  let latestPendingRevision: number | undefined;
  const sessionPositions = new Map<string | null, { followsLatest: boolean; scrollTop: number }>();
  let lastScroll = snapshotScroll();

  function snapshotScroll() {
    const pane = options.pane();
    return pane ? {
      pane,
      clientHeight: pane.clientHeight,
      scrollHeight: pane.scrollHeight,
      scrollTop: pane.scrollTop,
    } : undefined;
  }

  function isNearBottom(): boolean {
    const pane = options.pane();
    if (!pane) return true;
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= BOTTOM_THRESHOLD_PX;
  }

  function handleScroll(): void {
    // Sending clears the composer and appends an attachment preview in the
    // same render. Its layout/queued scrolls must not cancel explicit follow
    // before tick completes, or later image decoding will no longer follow.
    if (!visible || restorePending || !options.pane()?.clientHeight) return;
    if (latestPendingRevision === scrollRevision) return;
    const current = snapshotScroll()!;
    const previous = lastScroll?.pane === current.pane ? lastScroll : undefined;
    const geometryChanged = previous !== undefined
      && (previous.clientHeight !== current.clientHeight || previous.scrollHeight !== current.scrollHeight);
    // Composer growth reduces the viewport before ResizeObserver's follow
    // frame. A layout scroll event at the old offset is not a reader moving
    // upward. Keep following, but still honor an actual upward scroll.
    const layoutMovedBottom = geometryChanged && current.scrollTop >= previous!.scrollTop;
    const waitingAtSameOffset = frame !== 0 && current.scrollTop === previous?.scrollTop;
    if (followsLatest && (layoutMovedBottom || waitingAtSameOffset)) {
      scheduleScrollToLatest();
    } else {
      followsLatest = isNearBottom();
    }
    lastScroll = current;
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

  // Session tabs share one pane. Save the outgoing reader state before DOM
  // replacement, never overwriting it with hidden or not-yet-restored geometry.
  function activateSession(sessionId: string | null): void {
    if (activatedSessionId === sessionId) return;
    if (activatedSessionId !== undefined) {
      const pane = options.pane();
      sessionPositions.set(activatedSessionId, {
        followsLatest,
        scrollTop: visible && !restorePending && pane?.clientHeight ? pane.scrollTop : savedScrollTop,
      });
    }
    activatedSessionId = sessionId;
    scrollRevision += 1;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const position = sessionPositions.get(sessionId);
    followsLatest = position?.followsLatest ?? true;
    savedScrollTop = position?.scrollTop ?? 0;
    restorePending = true;
    scheduleScrollToLatest();
  }

  function jumpToLatest(): void {
    scrollRevision += 1;
    followsLatest = true;
    scheduleScrollToLatest();
  }

  function applyScrollPosition(pane: HTMLDivElement): void {
    pane.scrollTop = followsLatest ? pane.scrollHeight : savedScrollTop;
    lastScroll = snapshotScroll();
    restorePending = false;
    // content-visibility and media layout can expose taller content during
    // the write itself. Do not assume the estimated bottom was the live edge:
    // keep a follow frame pending so its queued, stationary scroll event cannot
    // disable following before ResizeObserver has a chance to catch up.
    if (followsLatest && !isNearBottom()) scheduleScrollToLatest();
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
      applyScrollPosition(pane);
    });
  }

  async function scrollToLatest(): Promise<void> {
    // Calls to this method come from explicit user/application actions such as
    // sending a prompt. Those actions should bring the conversation back to the
    // live edge even when the user had previously scrolled up.
    followsLatest = true;
    const sessionId = options.activeSessionId();
    const revision = ++scrollRevision;
    latestPendingRevision = revision;
    await tick();
    if (latestPendingRevision === revision) latestPendingRevision = undefined;
    if (revision !== scrollRevision || sessionId !== options.activeSessionId()) return;
    const pane = options.pane();
    if (visible && pane?.clientHeight) {
      applyScrollPosition(pane);
    }
  }

  function scrollToEntry(entryId: string): void {
    const target = options.pane()?.querySelector<HTMLElement>(
      `[data-transcript-entry-id="${CSS.escape(entryId)}"]`,
    );
    if (!target) return;
    scrollRevision += 1;
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
    if (lastScroll?.pane !== pane) lastScroll = snapshotScroll();
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
    scrollRevision += 1;
    sessionPositions.clear();
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
  }

  return {
    get followsLatest() { return followsLatest; },
    get restoring() { return restorePending; },
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
