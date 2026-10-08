type HistoryPagerOptions = {
  pane: () => HTMLDivElement | null;
  activeSessionId: () => string | null;
  followsLatest: () => boolean;
  restoring: () => boolean;
  loadOlder: () => Promise<boolean>;
  afterRender: () => Promise<void>;
};

const OLDER_HISTORY_THRESHOLD_PX = 96;

export function createTranscriptHistoryPager(options: HistoryPagerOptions) {
  let pending = false;
  let disposed = false;

  function viewportAnchor(pane: HTMLDivElement): { id: string; top: number } | null {
    const paneTop = pane.getBoundingClientRect().top;
    for (const entry of pane.querySelectorAll<HTMLElement>("[data-transcript-entry-id]")) {
      const rect = entry.getBoundingClientRect();
      if (rect.bottom < paneTop) continue;
      const id = entry.dataset.transcriptEntryId;
      if (id) return { id, top: rect.top };
    }
    return null;
  }

  async function loadAtTop(): Promise<void> {
    const pane = options.pane();
    if (disposed || options.restoring() || !pane?.clientHeight || pending || pane.scrollTop > OLDER_HISTORY_THRESHOLD_PX) return;
    const followingAtStart = options.followsLatest();
    // A remounted pane starts at zero before its restore frame. That is not
    // reader intent to fetch history; only auto-fill a following pane if it fits.
    if (followingAtStart && pane.scrollHeight > pane.clientHeight) return;
    const sessionId = options.activeSessionId();
    if (!sessionId) return;
    const ownsRequest = () => !disposed
      && !options.restoring()
      && pane === options.pane()
      && sessionId === options.activeSessionId();

    pending = true;
    const anchor = viewportAnchor(pane);
    const previousScrollHeight = pane.scrollHeight;
    const previousScrollTop = pane.scrollTop;
    let loadedOlderHistory = false;
    try {
      const loaded = await options.loadOlder();
      if (!loaded || !ownsRequest()) return;
      loadedOlderHistory = true;
      await options.afterRender();
      if (!ownsRequest()) return;
      // Follow-latest owns the viewport during restoration/auto-fill. An old
      // top anchor would pull it back into the transcript after the restore.
      // An explicit jump while a reader's history request waits also wins.
      if (followingAtStart || options.followsLatest()) return;

      const anchorTarget = anchor
        ? pane.querySelector<HTMLElement>(`[data-transcript-entry-id="${CSS.escape(anchor.id)}"]`)
        : null;
      if (anchorTarget && anchor) {
        pane.scrollTop += anchorTarget.getBoundingClientRect().top - anchor.top;
      } else {
        pane.scrollTop = previousScrollTop + Math.max(0, pane.scrollHeight - previousScrollHeight);
      }
    } finally {
      pending = false;
      if (
        loadedOlderHistory
        && ownsRequest()
        && pane.scrollTop <= OLDER_HISTORY_THRESHOLD_PX
      ) {
        void options.afterRender().then(() => loadAtTop());
      }
    }
  }

  return { loadAtTop, dispose: () => { disposed = true; } };
}
