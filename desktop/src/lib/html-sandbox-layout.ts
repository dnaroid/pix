/**
 * HTML previews are part of the transcript, not fullscreen web pages.
 * Fit short demos naturally; long demos have their own thin scrollbar instead
 * of growing the entire conversation by thousands of pixels.
 */
export const SANDBOX_INITIAL_HEIGHT = 380;
export const SANDBOX_MIN_HEIGHT = 180;

export interface HtmlSandboxViewport {
  /** Available content width (not the entire Desktop window), in CSS px. */
  readonly width: number;
  /** Maximum normal inline sandbox height, in CSS px. */
  readonly maxHeight: number;
}

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

/**
 * Runtime hint, supplied only for likely HTML/prototype requests.
 * The actual iframe viewport remains responsive to subsequent window resizes.
 */
export function sandboxViewportHint(text: string, viewport: HtmlSandboxViewport | undefined): string | undefined {
  if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.maxHeight)
    || viewport.width < 200 || viewport.width > 10000
    || viewport.maxHeight < 200 || viewport.maxHeight > 10000) return undefined;
  if (!/(?:\bpix-html\b|\bhtml[- ]sandbox\b|\bcanvas\b|\bphaser\b|\bthree\.js\b|\banimat(?:e|ion|ed)\b|\b[23]d\s+scene\b|\binteractive\b|\bprototype\b|\bgame\b|анимаци|анимиру|[23]д.{0,8}сцен|прототип|интерактивн|мини.игр|игру|игра|игры|игре|калькулятор)/iu.test(text)) return undefined;

  return "[Pix Desktop HTML Sandbox layout context, measured when this prompt was submitted]: "
    + `An inline \`pix-html\` preview has approximately ${Math.round(viewport.width)} CSS px of width and can auto-grow up to ${Math.round(viewport.maxHeight)} CSS px before it scrolls internally. `
    + "Make self-contained HTML/CSS/JS prototypes responsive: max-width: 100%, no fixed min-width, "
    + "and size Canvas using its parent width and window resize rather than assuming a full browser tab. "
    + "These dimensions are a snapshot; viewport dimensions may change at runtime.";
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
