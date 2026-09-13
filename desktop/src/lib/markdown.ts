import { renderBlocks } from "./markdown-blocks";
import {
  createMarkdownRenderContext,
  type MarkdownRenderOptions,
} from "./markdown-context";
import { stripDcpControlMetadata } from "./markdown-dcp";

export type { MarkdownRenderOptions } from "./markdown-context";
export { stripDcpControlMetadata } from "./markdown-dcp";
export {
  normalizeExternalHref,
  normalizeHomeFileDestination,
  normalizeLocalFileDestination,
  normalizeProjectFileDestination,
} from "./markdown-links";

/**
 * Render the deliberately small Markdown subset used by Desktop.
 * All source text is safely escaped here or by the syntax highlighter before
 * the result reaches Svelte's `{@html}`.
 */
export function renderMarkdown(text: string, options: MarkdownRenderOptions = {}): string {
  if (!text) return "";
  const context = createMarkdownRenderContext(options);
  return renderBlocks(stripDcpControlMetadata(text).replace(/\r\n?/g, "\n").split("\n"), 0, context);
}
