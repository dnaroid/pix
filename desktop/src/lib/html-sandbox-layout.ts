/**
 * HTML previews are part of the transcript, not fullscreen web pages.
 * Fit short demos naturally; long demos have their own thin scrollbar instead
 * of growing the entire conversation by thousands of pixels.
 */
export const SANDBOX_INITIAL_HEIGHT = 380;
export const SANDBOX_MIN_HEIGHT = 180;

function safeWindowHeight(height: number): number {
  return Number.isFinite(height) && height > 0 ? height : 800;
}

export function sandboxInlineHeightLimit(windowHeight: number): number {
  return Math.round(Math.min(1100, Math.max(480, safeWindowHeight(windowHeight) * 1.35)));
}

export function sandboxExpandedHeightLimit(windowHeight: number): number {
  return Math.round(Math.min(1600, Math.max(900, safeWindowHeight(windowHeight) * 1.85)));
}

export function sandboxFrameHeight(
  desiredHeight: number | undefined,
  expanded: boolean,
  windowHeight: number,
): number {
  const desired = Number.isFinite(desiredHeight) && (desiredHeight ?? 0) > 0
    ? desiredHeight!
    : SANDBOX_INITIAL_HEIGHT;
  if (expanded) {
    const minimum = Math.min(720, Math.round(safeWindowHeight(windowHeight) * 0.8));
    return Math.round(Math.max(minimum, Math.min(desired, sandboxExpandedHeightLimit(windowHeight))));
  }
  return Math.round(Math.min(
    Math.max(SANDBOX_MIN_HEIGHT, desired),
    sandboxInlineHeightLimit(windowHeight),
  ));
}

const SANDBOX_VIEWPORT_HINT_PREFIX =
  "[Pix Desktop HTML Sandbox layout context, measured when this prompt was submitted]: ";

/**
 * Legacy Desktop builds appended a keyword-triggered viewport hint as the final
 * prompt block. It is no longer sent; strip it from persisted history so it
 * never appears in user bubbles or restored composer drafts.
 */
export function stripSandboxViewportHint(promptText: string): string {
  const index = promptText.lastIndexOf(SANDBOX_VIEWPORT_HINT_PREFIX);
  if (index < 0 || (index > 0 && promptText[index - 1] !== "\n")) return promptText;
  return promptText.slice(0, index).trimEnd();
}

export interface SandboxContentSize {
  readonly height: number;
}

/** Treat iframe measurements as untrusted; never let them grow the whole chat unbounded. */
export function parseSandboxContentSize(value: unknown): SandboxContentSize | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const packet = value as Record<string, unknown>;
  if (packet.channel !== "pix-html-sandbox" || packet.type !== "content-size"
    || typeof packet.height !== "number" || !Number.isFinite(packet.height)
    || packet.height < 0 || packet.height > 100000) return undefined;
  return { height: Math.round(packet.height) };
}
