/** Activate a focusable SVG chart element with Enter/Space, like a button. */
export function activateOnKey(event: KeyboardEvent, action: () => void): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
}

/** Anchor rectangle for the usage tooltip (viewport coordinates). */
export type UsageTooltipAnchor = { left: number; top: number; width: number; height: number };

export function anchorOf(element: Element): UsageTooltipAnchor {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}
