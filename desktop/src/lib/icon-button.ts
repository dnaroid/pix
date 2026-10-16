/*
 * Shared quiet icon-action geometry (DESIGN.md §8.2, §10): 24 px (sm) or
 * 28 px (md) square, muted until hover, hover surface matching the host
 * region. Keyboard focus uses the global restrained :focus-visible ring.
 * Class literals stay static so Tailwind's scanner sees every token.
 */
export type IconButtonSize = "sm" | "md";
export type IconButtonSurface = "chrome" | "panel" | "popover";
export type IconButtonTone = "default" | "danger";

const BASE = "grid shrink-0 place-items-center text-muted-foreground transition-colors disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";
const SIZE: Record<IconButtonSize, string> = { sm: "h-6 w-6 rounded-sm", md: "h-7 w-7 rounded-md" };
const SURFACE: Record<IconButtonSurface, string> = {
  chrome: "hover:bg-chrome-hover",
  panel: "hover:bg-panel-hover",
  popover: "hover:bg-accent",
};
const TONE: Record<IconButtonTone, string> = {
  default: "hover:text-foreground disabled:hover:text-muted-foreground",
  danger: "hover:text-destructive disabled:hover:text-muted-foreground",
};

export function iconButtonClass(
  size: IconButtonSize,
  surface: IconButtonSurface,
  options: { tone?: IconButtonTone; extra?: string } = {},
): string {
  return [BASE, SIZE[size], SURFACE[surface], TONE[options.tone ?? "default"], options.extra ?? ""]
    .filter(Boolean)
    .join(" ");
}
