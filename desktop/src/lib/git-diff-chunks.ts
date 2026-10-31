/**
 * Git Diff renders up to 512 KB (tens of thousands of lines). Rendering it as
 * fixed-size chunks lets the pane mount a first screen synchronously, append
 * the rest over animation frames, and let the browser skip layout/paint of
 * offscreen chunks (content-visibility) while their text stays selectable.
 */
export const GIT_DIFF_CHUNK_LINES = 256;
/** Line height of a diff row in px (`leading-4`/`min-h-4`). */
export const GIT_DIFF_LINE_HEIGHT_PX = 16;
const TAB_COLUMNS = 8;

export interface DiffLineChunk {
  readonly lines: readonly string[];
  /** Longest line in monospace columns; sizes the chunk while it is skipped. */
  readonly columns: number;
}

export function chunkDiffLines(content: string, size = GIT_DIFF_CHUNK_LINES): DiffLineChunk[] {
  const lines = content.split("\n");
  const chunks: DiffLineChunk[] = [];
  for (let start = 0; start < lines.length; start += size) {
    const slice = lines.slice(start, start + size);
    let columns = 0;
    for (const line of slice) columns = Math.max(columns, displayColumns(line));
    chunks.push({ lines: slice, columns });
  }
  return chunks;
}

function displayColumns(line: string): number {
  let tabs = 0;
  for (let index = line.indexOf("\t"); index !== -1; index = line.indexOf("\t", index + 1)) tabs++;
  return line.length + tabs * (TAB_COLUMNS - 1);
}

/** `contain-intrinsic-size` used while a chunk is offscreen and not yet measured. */
export function diffChunkIntrinsicSize(chunk: DiffLineChunk): string {
  return `contain-intrinsic-size: auto calc(${chunk.columns}ch + 1.5rem) auto ${chunk.lines.length * GIT_DIFF_LINE_HEIGHT_PX}px`;
}

export function diffLineTone(line: string): string {
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "text-muted-foreground";
  if (line.startsWith("+")) return "bg-tool-success/7 text-tool-success";
  if (line.startsWith("-")) return "bg-tool-error/7 text-tool-error";
  if (line.startsWith("@@")) return "bg-tool-info/6 text-tool-info";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "text-foreground font-semibold";
  return "text-foreground/80";
}

export const GIT_DIFF_INITIAL_CHUNKS = 4;
export const GIT_DIFF_CHUNKS_PER_FRAME = 4;

/**
 * Reveals `total` chunks progressively: the initial batch is the caller's
 * synchronous render; each later frame appends one batch. Disposal (diff
 * replacement or unmount) cancels the pending frame so a stale reveal never
 * publishes into a newer diff.
 */
export function revealDiffChunks(
  total: number,
  onReveal: (count: number) => void,
  schedule: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
  cancel: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
): () => void {
  let count = Math.min(GIT_DIFF_INITIAL_CHUNKS, total);
  let handle: number | undefined;
  let disposed = false;
  const step = () => {
    handle = undefined;
    if (disposed) return;
    count = Math.min(count + GIT_DIFF_CHUNKS_PER_FRAME, total);
    onReveal(count);
    if (count < total) handle = schedule(step);
  };
  if (count < total) handle = schedule(step);
  return () => {
    disposed = true;
    if (handle !== undefined) cancel(handle);
    handle = undefined;
  };
}
