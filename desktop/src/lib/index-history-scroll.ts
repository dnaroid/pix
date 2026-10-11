export function isHistoryAtBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.clientHeight - node.scrollTop <= 4;
}

/** Keep the visible record stable when the bounded history drops older rows. */
export function captureHistoryPosition(node: HTMLElement) {
  const top = node.getBoundingClientRect().top;
  const anchor = Array.from(node.querySelectorAll<HTMLElement>("[data-event-id]"))
    .find(row => row.getBoundingClientRect().bottom > top);
  return {
    pinned: isHistoryAtBottom(node),
    id: anchor?.dataset.eventId,
    offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
    scrollTop: node.scrollTop,
  };
}

export function restoreHistoryPosition(node: HTMLElement, position: ReturnType<typeof captureHistoryPosition>): void {
  if (position.pinned) {
    node.scrollTop = node.scrollHeight;
    return;
  }
  const anchor = Array.from(node.querySelectorAll<HTMLElement>("[data-event-id]"))
    .find(row => row.dataset.eventId === position.id);
  if (anchor) {
    node.scrollTop += anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - position.offset;
  } else {
    node.scrollTop = position.id ? 0 : position.scrollTop;
  }
}

/** Follow is reader intent, not geometry after a new row has moved the bottom. */
export function createHistoryScrollTracker(node: HTMLElement) {
  let followsLatest = true;
  let scrollTop = node.scrollTop;
  let revision = 0;

  return {
    capture() {
      return { ...captureHistoryPosition(node), pinned: followsLatest, revision };
    },
    handleScroll() {
      if (!node.clientHeight) return;
      const moved = Math.abs(node.scrollTop - scrollTop) > 0.5;
      if (isHistoryAtBottom(node)) followsLatest = true;
      else if (node.scrollTop < scrollTop - 0.5) followsLatest = false;
      // Delayed programmatic scroll events at the same offset must not cancel
      // the pending restore merely because new content has grown below it.
      if (moved) revision++;
      scrollTop = node.scrollTop;
    },
    restore(position: ReturnType<typeof captureHistoryPosition> & { revision: number }) {
      if (position.revision !== revision || !node.clientHeight) return;
      restoreHistoryPosition(node, position);
      scrollTop = node.scrollTop;
    },
    resize() {
      if (!followsLatest || !node.clientHeight) return;
      node.scrollTop = node.scrollHeight;
      scrollTop = node.scrollTop;
    },
  };
}
