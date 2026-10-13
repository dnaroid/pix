// Bump when the searchable projection changes, even if the JSONL file does not.
export const SESSION_TEXT_VERSION = "public-text-v2";

/** Sandbox source is an attachment, not prose. Unclosed attachments stay excluded.
 * Respect other fences so a quoted Markdown example is not an executable block. */
export function excludeSessionAttachments(text) {
  const kept = [];
  let fence;
  for (const line of text.split(/(?<=\n)/u)) {
    const body = line.replace(/[\r\n]+$/u, "");
    if (fence) {
      if (!fence.attachment) kept.push(line);
      const trimmed = body.trim();
      let length = 0;
      while (trimmed[length] === fence.marker) length++;
      if (length >= fence.length && trimmed.slice(length).trim() === "") fence = undefined;
      continue;
    }
    const match = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/u.exec(body);
    if (match) {
      const language = match[2].trim().split(/\s+/u, 1)[0].toLowerCase();
      fence = { marker: match[1][0], length: match[1].length,
        attachment: language === "pix-html" || language === "html-sandbox" };
    }
    if (!fence?.attachment) kept.push(line);
  }
  return kept.join("");
}
