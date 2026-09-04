export interface PreviewHistory<T> {
  readonly entries: readonly T[];
  readonly index: number;
}

export interface PreviewScrollPosition {
  readonly left: number;
  readonly top: number;
}

export function emptyPreviewHistory<T>(): PreviewHistory<T> {
  return { entries: [], index: -1 };
}

export function resetPreviewHistory<T>(entry: T): PreviewHistory<T> {
  return { entries: [entry], index: 0 };
}

export function pushPreviewHistory<T>(history: PreviewHistory<T>, entry: T): PreviewHistory<T> {
  const entries = [...history.entries.slice(0, history.index + 1), entry];
  return { entries, index: entries.length - 1 };
}

export function movePreviewHistory<T>(history: PreviewHistory<T>, offset: -1 | 1): PreviewHistory<T> {
  const index = Math.max(0, Math.min(history.index + offset, history.entries.length - 1));
  return history.entries.length === 0 || index === history.index ? history : { ...history, index };
}

export function currentPreview<T>(history: PreviewHistory<T>): T | undefined {
  return history.entries[history.index];
}

export function replaceCurrentPreview<T>(history: PreviewHistory<T>, entry: T): PreviewHistory<T> {
  if (history.index < 0 || history.index >= history.entries.length) return history;
  if (Object.is(history.entries[history.index], entry)) return history;

  const entries = [...history.entries];
  entries[history.index] = entry;
  return { entries, index: history.index };
}

export function canMovePreviewHistory<T>(history: PreviewHistory<T>, offset: -1 | 1): boolean {
  const nextIndex = history.index + offset;
  return nextIndex >= 0 && nextIndex < history.entries.length;
}
