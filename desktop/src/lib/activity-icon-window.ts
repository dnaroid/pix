/** 14px icon + 2px gap, matching the compact trail's geometry. */
export const ACTIVITY_ICON_PITCH = 16;
const OVERSCAN = 4;

/** Bound SVG mounts without dropping calls from the horizontally scrollable trail. */
export function activityIconWindow(count: number, scrollLeft: number, viewportWidth: number): { start: number; end: number } {
  if (count <= 128) return { start: 0, end: count };
  const visible = Math.max(1, Math.ceil(viewportWidth / ACTIVITY_ICON_PITCH));
  const first = Math.min(Math.max(0, Math.floor(scrollLeft / ACTIVITY_ICON_PITCH)), Math.max(0, count - visible));
  return { start: Math.max(0, first - OVERSCAN), end: Math.min(count, first + visible + OVERSCAN) };
}
