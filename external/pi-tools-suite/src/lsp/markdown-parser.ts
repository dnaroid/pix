import MarkdownIt from "markdown-it";

// The language server uses block tokens (including html_block) to exclude
// non-Markdown content from its own link scanner. Keep their original maps.
const parser = new MarkdownIt({ html: true });

export function parseMarkdownTokens(text: string) {
  return parser.parse(text, {});
}

/** Mask non-link content without changing UTF-16 positions or line endings. */
export function markdownLinkText(text: string): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  const chars = text.split("");
  const mask = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  };
  for (const token of parseMarkdownTokens(text)) {
    if (token.map && ["html_block", "code_block", "fence"].includes(token.type)) {
      mask(starts[token.map[0]], starts[token.map[1]] ?? text.length);
    }
  }
  const blocksMasked = chars.join("");
  // Inline comments and code spans can occur in otherwise visible paragraphs.
  const pattern = /<!--|`+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(blocksMasked))) {
    if (match[0] === "<!--") {
      const close = blocksMasked.indexOf("-->", pattern.lastIndex);
      const end = close < 0 ? text.length : close + 3;
      mask(match.index, end);
      pattern.lastIndex = end;
      continue;
    }
    let escapes = 0;
    for (let i = match.index - 1; i >= 0 && blocksMasked[i] === "\\"; i--) escapes++;
    if (escapes % 2) continue;
    const closing = /`+/g;
    closing.lastIndex = pattern.lastIndex;
    let end: RegExpExecArray | null;
    while ((end = closing.exec(blocksMasked))) {
      if (end[0].length !== match[0].length) continue;
      mask(match.index, closing.lastIndex);
      pattern.lastIndex = closing.lastIndex;
      break;
    }
  }
  return chars.join("");
}
