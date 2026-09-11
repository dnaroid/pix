export type CompositeOrientation = "horizontal" | "vertical";

export interface MenuNavigationItem {
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * Resolve conventional arrow/Home/End movement inside a one-dimensional
 * composite widget such as a toolbar, menu, tablist, or visible tree row list.
 */
export function linearFocusIndex(
  currentIndex: number,
  key: string,
  itemCount: number,
  orientation: CompositeOrientation,
  wrap = true,
): number | null {
  if (itemCount <= 0 || currentIndex < 0 || currentIndex >= itemCount) return null;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;

  const backwardKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const forwardKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  if (key !== backwardKey && key !== forwardKey) return null;

  const direction = key === forwardKey ? 1 : -1;
  const next = currentIndex + direction;
  if (wrap) return (next + itemCount) % itemCount;
  return Math.max(0, Math.min(itemCount - 1, next));
}

/** Find the next item whose visible label starts with the accumulated query. */
export function typeaheadFocusIndex(
  labels: readonly string[],
  currentIndex: number,
  query: string,
): number | null {
  const normalizedQuery = normalizeTypeaheadText(query);
  if (!normalizedQuery || labels.length === 0) return null;

  for (let offset = 1; offset <= labels.length; offset += 1) {
    const index = (currentIndex + offset + labels.length) % labels.length;
    if (normalizeTypeaheadText(labels[index] ?? "").startsWith(normalizedQuery)) return index;
  }
  return null;
}

/** Resolve ArrowUp/ArrowDown/Home/End across enabled menu items only. */
export function menuFocusIndex(
  items: readonly MenuNavigationItem[],
  currentIndex: number,
  key: string,
): number | null {
  const enabledIndices = items.flatMap((item, index) => item.disabled ? [] : [index]);
  if (enabledIndices.length === 0) return null;
  if (key === "Home") return enabledIndices[0] ?? null;
  if (key === "End") return enabledIndices.at(-1) ?? null;
  if (key !== "ArrowDown" && key !== "ArrowUp") return null;

  const currentEnabledIndex = enabledIndices.indexOf(currentIndex);
  if (currentEnabledIndex < 0) return key === "ArrowDown"
    ? enabledIndices[0] ?? null
    : enabledIndices.at(-1) ?? null;
  const direction = key === "ArrowDown" ? 1 : -1;
  const next = (currentEnabledIndex + direction + enabledIndices.length) % enabledIndices.length;
  return enabledIndices[next] ?? null;
}

/** Type-ahead search across enabled menu items only. */
export function menuTypeaheadFocusIndex(
  items: readonly MenuNavigationItem[],
  currentIndex: number,
  query: string,
): number | null {
  const normalizedQuery = normalizeTypeaheadText(query);
  if (!normalizedQuery || items.length === 0) return null;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (currentIndex + offset + items.length) % items.length;
    const item = items[index];
    if (!item || item.disabled) continue;
    if (normalizeTypeaheadText(item.label).startsWith(normalizedQuery)) return index;
  }
  return null;
}

export function isTypeaheadKey(event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">): boolean {
  return event.key.length === 1
    && event.key !== " "
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey;
}

function normalizeTypeaheadText(value: string): string {
  return value.trim().toLocaleLowerCase();
}
