export interface TextSearchMatch {
  readonly start: number;
  readonly end: number;
}

/** Length-preserving ASCII case fold; keeps match offsets valid for `value`. */
function asciiFold(value: string): string {
  return value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

// Find-in-file searches the same text on every keystroke and Enter. Folding a
// large file is linear, so keep the last folded haystack (by string value).
let foldedSource: string | undefined;
let foldedText = "";
function foldedHaystack(text: string): string {
  if (text !== foldedSource) {
    foldedSource = text;
    foldedText = asciiFold(text);
  }
  return foldedText;
}

export function findTextMatches(
  text: string,
  query: string,
  limit = 1_000,
): TextSearchMatch[] {
  if (!query.trim() || limit <= 0) return [];
  const haystack = foldedHaystack(text);
  const foldedNeedle = asciiFold(query);
  const matches: TextSearchMatch[] = [];
  let offset = 0;
  while (offset <= haystack.length && matches.length < limit) {
    const found = haystack.indexOf(foldedNeedle, offset);
    if (found < 0) break;
    matches.push({ start: found, end: found + foldedNeedle.length });
    offset = found + Math.max(1, foldedNeedle.length);
  }
  return matches;
}

export interface TextOffsetSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Binary-searches ordered, contiguous spans for an offset. A match start lies in
 * `[start, end)`; a match end lies in `(start, end]`. Empty spans never match.
 */
export function findSpanIndex(
  spans: readonly TextOffsetSpan[],
  offset: number,
  edge: "start" | "end",
): number {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const span = spans[middle]!;
    const before = edge === "start" ? offset < span.start : offset <= span.start;
    const after = edge === "start" ? offset >= span.end : offset > span.end;
    if (before) high = middle - 1;
    else if (after) low = middle + 1;
    else return middle;
  }
  return -1;
}

/** Zero-based line of `offset` without allocating a prefix copy of the text. */
export function lineIndexAt(text: string, offset: number): number {
  let line = 0;
  for (let index = text.indexOf("\n"); index !== -1 && index < offset; index = text.indexOf("\n", index + 1)) line++;
  return line;
}
