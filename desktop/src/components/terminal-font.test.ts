// @ts-expect-error Node fs import in Vitest runner
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { refreshAfterTerminalFontLoad } from "./terminal-font";

// Read the bundled font's Unicode cmap (format 12) rather than assuming that
// naming a Nerd Font guarantees the PUA glyphs used by prompts and Pix icons.
function fontHasGlyph(bytes: Uint8Array, codepoint: number): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableCount = view.getUint16(4);
  for (let table = 0; table < tableCount; table++) {
    const record = 12 + table * 16;
    if (String.fromCharCode(...bytes.subarray(record, record + 4)) !== "cmap") continue;
    const cmap = view.getUint32(record + 8);
    const subtables = view.getUint16(cmap + 2);
    for (let subtable = 0; subtable < subtables; subtable++) {
      const encoding = cmap + 4 + subtable * 8;
      const offset = cmap + view.getUint32(encoding + 4);
      if (view.getUint16(offset) !== 12) continue;
      const groups = view.getUint32(offset + 12);
      for (let group = 0; group < groups; group++) {
        const entry = offset + 16 + group * 12;
        if (codepoint >= view.getUint32(entry) && codepoint <= view.getUint32(entry + 4)) {
          return view.getUint32(entry + 8) + codepoint - view.getUint32(entry) !== 0;
        }
      }
    }
  }
  return false;
}

describe("bundled terminal Nerd fallback", () => {
  it("includes glyphs from the Nerd icon, powerline, and supplementary PUA ranges", () => {
    const font = readFileSync(new URL("./fonts/JetBrainsMonoNerdFontMono-Regular.ttf", import.meta.url));
    expect(new DataView(font.buffer, font.byteOffset, font.byteLength).getUint32(0)).toBe(0x00010000);
    for (const codepoint of [0xe0b0, 0xf013, 0xf0001]) {
      expect(fontHasGlyph(font, codepoint), `U+${codepoint.toString(16)}`).toBe(true);
    }
    // Vite copies public/ into dist; a license held only alongside src/ is omitted.
    const license = readFileSync(new URL("../../public/fonts/OFL.txt", import.meta.url), "utf8");
    expect(license).toContain("Copyright 2020 The JetBrains Mono Project Authors");
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(license).toContain("PERMISSION & CONDITIONS");
    expect(license).toContain("OTHER DEALINGS IN THE FONT SOFTWARE.");
  });

  it("invalidates cached DOM glyph widths before repainting only the current terminal", async () => {
    let resolve!: () => void;
    const loaded = new Promise<void>((done) => { resolve = done; });
    let current = true;
    let fontLoaded = false;
    let cachedIconWidth: number | undefined;
    let family = '"Geist Mono", "Pix Terminal Nerd Glyphs", ui-monospace, monospace';
    const changes: string[] = [];
    const paintedWidths: number[] = [];
    const terminal = {
      options: {
        get fontFamily() { return family; },
        set fontFamily(value: string) {
          if (family === value) return; // xterm ignores same-value option writes
          family = value;
          changes.push(value);
          cachedIconWidth = undefined; // xterm's DOM WidthCache.setFont behavior
        },
      },
      rows: 24,
      refresh(start: number, end: number) {
        expect([start, end]).toEqual([0, 23]);
        paintedWidths.push(cachedIconWidth ??= fontLoaded ? 10 : 5);
      },
    };
    terminal.refresh(0, 23); // icon was first drawn using the missing-font width
    refreshAfterTerminalFontLoad(() => loaded, () => current, terminal);
    expect(paintedWidths).toEqual([5]);
    fontLoaded = true;
    resolve();
    await loaded;
    expect(changes).toEqual([`${family}, "__Pix font reload__"`, family]);
    expect(terminal.options.fontFamily).toBe(family);
    expect(paintedWidths).toEqual([5, 10]);

    let resolveLate!: () => void;
    const late = new Promise<void>((done) => { resolveLate = done; });
    refreshAfterTerminalFontLoad(() => late, () => current, terminal);
    current = false;
    resolveLate();
    await late;
    expect(changes).toHaveLength(2);
    expect(paintedWidths).toEqual([5, 10]);

    refreshAfterTerminalFontLoad(() => Promise.reject(new Error("font unavailable")), () => true, terminal);
    await Promise.resolve();
    expect(changes).toHaveLength(2);
    expect(paintedWidths).toEqual([5, 10]);
  });
});
