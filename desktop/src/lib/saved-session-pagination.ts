/** The saved-conversation chooser renders only one small page at startup. */
export const SAVED_SESSION_INITIAL_ROWS = 30;
export const SAVED_SESSION_NEXT_ROWS = 15;

/** Clamp the next page to the currently filtered list. */
export function nextSavedSessionRowCount(current: number, total: number): number {
  return Math.min(total, Math.max(0, current) + SAVED_SESSION_NEXT_ROWS);
}

/** Render a prefix of the fully ordered/filtered tree, never a separately ranked page. */
export function visibleSavedSessionRows<T>(rows: readonly T[], limit: number): readonly T[] {
  return rows.slice(0, Math.max(0, limit));
}
