/** Only an explicit leading document status is metadata. Never infer it from a
 * path, prose mentioning another document, or a code example. The caller must
 * supply content from the existing hash-verified source checkpoint. */
export function documentLifecycle(text) {
  const lines = text.split("\n", 32);
  let fence;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (/^#{2,6}\s/.test(line)) break;
    const match = /^\s*(?:[-*]\s+)?(?:\*\*)?Status(?:\*\*)?:\s*(superseded|deprecated|archived|obsolete|draft|accepted|active)\b/i.exec(line);
    if (match) return match[1].toLowerCase();
  }
}
