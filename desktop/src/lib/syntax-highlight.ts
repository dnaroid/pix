import { highlight, type LanguageName } from "sugar-high";
import { lang } from "sugar-high/lang";
import { escapeHtml } from "./markdown-escape";
import { highlightGDScript } from "./gdscript-highlight";

type CodeLanguage = LanguageName | "gdscript";

export interface HighlightedCode {
  readonly html: string;
  readonly language: CodeLanguage;
}

// Token markup can be tens of times larger than the source. Avoid lexing and
// creating that many DOM nodes synchronously for large previews/tool results.
const MAX_HIGHLIGHT_CHARS = 32 * 1024;

// Streaming Markdown re-renders every settled fence on each frame. A small
// LRU bounded by output size keeps that lookup-only instead of re-lexing.
const HIGHLIGHT_CACHE_MAX_ENTRIES = 128;
const HIGHLIGHT_CACHE_MAX_CHARS = 4 * 1024 * 1024;
const highlightCache = new Map<string, HighlightedCode>();
let highlightCacheChars = 0;

/** Keep source and line navigation intact even when token highlighting is too expensive. */
export function highlightCode(code: string, languageHint?: string): HighlightedCode {
  const key = `${languageHint ?? ""}\0${code}`;
  const cached = highlightCache.get(key);
  if (cached) {
    highlightCache.delete(key);
    highlightCache.set(key, cached);
    return cached;
  }
  const highlighted = highlightUncached(code, languageHint);
  const size = key.length + highlighted.html.length;
  if (size <= HIGHLIGHT_CACHE_MAX_CHARS / 8) {
    highlightCache.set(key, highlighted);
    highlightCacheChars += size;
    for (const [oldestKey, oldest] of highlightCache) {
      if (highlightCache.size <= HIGHLIGHT_CACHE_MAX_ENTRIES && highlightCacheChars <= HIGHLIGHT_CACHE_MAX_CHARS) break;
      highlightCache.delete(oldestKey);
      highlightCacheChars -= oldestKey.length + oldest.html.length;
    }
  }
  return highlighted;
}

function highlightUncached(code: string, languageHint?: string): HighlightedCode {
  let language: CodeLanguage = "plaintext";
  if (code.length <= MAX_HIGHLIGHT_CHARS && languageHint) {
    if (/^(gd|gdscript)$/i.test(languageHint)) language = "gdscript";
    else if (/^mjs$/i.test(languageHint)) language = "javascript";
    else language = lang(languageHint) ?? "plaintext";
  }
  let html: string;
  if (language === "plaintext") {
    html = code.split("\n").map((line) => `<span class="sh__line">${escapeHtml(line)}</span>`).join("\n");
  } else if (language === "gdscript") {
    html = refineTokens(highlightGDScript(code));
  } else {
    html = refineTokens(highlight(code, { lang: language }));
  }
  return { html, language };
}

const NAME_BEFORE_CALL = /<span class="sh__token--(?:identifier|property)" style="color:var\(--sh-(?:identifier|property)\)">([^<]+)<\/span>(?=(?:<span class="sh__token--space"[^>]*>[^<]*<\/span>)?<span class="sh__token--sign"[^>]*>\()/gu;
const CLASS_TOKEN = /<span class="sh__token--class" style="color:var\(--sh-class\)">([^<]+)<\/span>/gu;
const NUMBER_LITERAL = /^(?:0[xob][\da-f_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:e[+-]?\d+)?[a-z]*)$/iu;

/**
 * Sugar High has no function or number roles. Names directly followed by `(`
 * (calls and declarations) become `function`; numeric `class` tokens become
 * `number`, so themes can color them like an IDE does.
 */
export function refineTokens(html: string): string {
  return html
    .replace(NAME_BEFORE_CALL, (_match, name: string) => `<span class="sh__token--function" style="color:var(--sh-function)">${name}</span>`)
    .replace(CLASS_TOKEN, (match, text: string) => NUMBER_LITERAL.test(text)
      ? `<span class="sh__token--number" style="color:var(--sh-number)">${text}</span>`
      : match);
}

/** Resolve Sugar High's canonical language from a file path. */
export function languageForFilePath(filePath: string): CodeLanguage | undefined {
  const cleanPath = filePath.split(/[?#]/, 1)[0] ?? "";
  const fileName = cleanPath.split(/[\\/]/).at(-1) ?? "";
  if (!fileName) return undefined;

  const namedLanguage = lang(fileName);
  if (namedLanguage) return namedLanguage;

  const extensionStart = fileName.lastIndexOf(".");
  if (extensionStart < 0) return undefined;

  const extension = fileName.slice(extensionStart + 1).toLowerCase();
  if (extension === "mjs") return "javascript";
  if (extension === "gd") return "gdscript";
  if (extension === "svelte") return "html";
  return lang(extension);
}

/** Read and ls share an ACP kind, so the title keeps directory listings unhighlighted. */
export function languageForReadTool(kind: string, title: string, path?: string): CodeLanguage | undefined {
  if (kind !== "read" || !/^read(?:\s|$)/i.test(title)) return undefined;
  return languageForFilePath(path ?? title.replace(/^read\s*/i, "").replace(/:\d+(?:\+\d+)?$/, ""));
}
