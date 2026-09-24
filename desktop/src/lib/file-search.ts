export interface TextSearchMatch {
  readonly start: number;
  readonly end: number;
}

function asciiFold(value: string): string {
  let folded = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    folded += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value[index];
  }
  return folded;
}

export function findTextMatches(
  text: string,
  query: string,
  limit = 1_000,
): TextSearchMatch[] {
  if (!query.trim() || limit <= 0) return [];
  const needle = query;
  const haystack = asciiFold(text);
  const foldedNeedle = asciiFold(needle);
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
