import { isClosingFence, parseFence, type MarkdownFence } from "./markdown-fences";

/**
 * Remove only complete DCP control blocks from the display copy. Session and
 * provider bytes stay untouched. Literal examples inside fenced code or block
 * quotes remain visible, and an incomplete marker fails open.
 */
export function stripDcpControlMetadata(text: string): string {
  if (!text.includes("<dcp-message-ids>")) return text;

  const lines = text.split("\n");
  const kept: string[] = [];
  let candidate: string[] | undefined;
  let inFence: MarkdownFence | undefined;
  let touched = false;

  for (const line of lines) {
    if (candidate) {
      candidate.push(line);
      if (/<\/dcp-message-ids>\s*$/i.test(line)) {
        candidate = undefined;
        touched = true;
      }
      continue;
    }

    const quoteLine = /^\s{0,3}>/.test(line);
    if (!quoteLine) {
      if (inFence) {
        if (isClosingFence(line, inFence)) inFence = undefined;
      } else {
        const fence = parseFence(line);
        if (fence) inFence = fence;
      }
    }

    if (!inFence && !quoteLine && /^\s*<dcp-message-ids>/i.test(line)) {
      if (/<\/dcp-message-ids>\s*$/i.test(line)) touched = true;
      else candidate = [line];
      continue;
    }

    kept.push(line);
  }

  if (candidate) kept.push(...candidate);
  return touched ? kept.join("\n").trimEnd() : text;
}
