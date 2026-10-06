export const BTW_DEFAULT_WIDTH = 380;
export const BTW_MIN_WIDTH = 300;
export const BTW_MAX_WIDTH = 640;

export function clampBtwPaneWidth(width: number, viewportWidth = Number.POSITIVE_INFINITY): number {
  const maxViewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth - Math.min(320, viewportWidth * 0.45)) : Number.POSITIVE_INFINITY;
  const max = Math.min(BTW_MAX_WIDTH, maxViewport);
  if (max < BTW_MIN_WIDTH) return Math.max(0, max);
  return Math.min(Math.max(Number.isFinite(width) ? width : BTW_DEFAULT_WIDTH, BTW_MIN_WIDTH), max);
}

export function btwPaneWidthFromKeyboard(
  width: number,
  key: string,
  viewportWidth = Number.POSITIVE_INFINITY,
): number {
  if (key === "Home") return clampBtwPaneWidth(BTW_MIN_WIDTH, viewportWidth);
  if (key === "End") return clampBtwPaneWidth(BTW_MAX_WIDTH, viewportWidth);
  if (key === "ArrowLeft") return clampBtwPaneWidth(width + 16, viewportWidth);
  if (key === "ArrowRight") return clampBtwPaneWidth(width - 16, viewportWidth);
  return clampBtwPaneWidth(width, viewportWidth);
}
