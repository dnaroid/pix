type FontRefreshTerminal = {
  options: { fontFamily?: string };
  rows: number;
  refresh(start: number, end: number): void;
};

/** Refresh xterm's font measurements and DOM glyph-width cache after the fallback loads. */
export function refreshAfterTerminalFontLoad(
  load: () => Promise<unknown>,
  isCurrent: () => boolean,
  terminal: FontRefreshTerminal,
): void {
  void load().then(() => {
    if (!isCurrent()) return;
    const family = terminal.options.fontFamily;
    if (family) {
      // xterm ignores assignments of the same option value. Changing the font
      // stack and restoring it triggers its supported option-change path, which
      // remeasures character size and clears the DOM renderer's width cache.
      // The missing trailing family does not change the selected glyph faces.
      try {
        terminal.options.fontFamily = `${family}, "__Pix font reload__"`;
      } finally {
        terminal.options.fontFamily = family;
      }
    }
    terminal.refresh(0, terminal.rows - 1);
  }).catch(() => { /* Keep the platform fallback if loading fails. */ });
}
