export interface MarkdownFence {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly language: string;
}

export function parseFence(line: string): MarkdownFence | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/);
  if (!match?.[1]) return undefined;
  return {
    marker: match[1][0] as MarkdownFence["marker"],
    length: match[1].length,
    language: (match[2] ?? "").trim().split(/\s+/, 1)[0] ?? "",
  };
}

export function isClosingFence(line: string, fence: MarkdownFence): boolean {
  const trimmed = line.trim();
  let markerCount = 0;
  while (trimmed[markerCount] === fence.marker) markerCount += 1;
  return markerCount >= fence.length && trimmed.slice(markerCount).trim() === "";
}
