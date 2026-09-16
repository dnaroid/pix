import { highlight, type LanguageName } from "sugar-high";
import { lang } from "sugar-high/lang";
import { escapeHtml } from "./markdown-escape";

export interface HighlightedCode {
  readonly html: string;
  readonly language: LanguageName;
}

// Token markup can be tens of times larger than the source. Avoid lexing and
// creating that many DOM nodes synchronously for large previews/tool results.
const MAX_HIGHLIGHT_CHARS = 32 * 1024;

/** Keep source and line navigation intact even when token highlighting is too expensive. */
export function highlightCode(code: string, languageHint?: string): HighlightedCode {
  let language: LanguageName = "plaintext";
  if (code.length <= MAX_HIGHLIGHT_CHARS && languageHint) language = lang(languageHint) ?? "plaintext";
  return {
    html: language === "plaintext"
      ? code.split("\n").map((line) => `<span class="sh__line">${escapeHtml(line)}</span>`).join("\n")
      : highlight(code, { lang: language }),
    language,
  };
}

/** Resolve Sugar High's canonical language from a file path. */
export function languageForFilePath(filePath: string): LanguageName | undefined {
  const cleanPath = filePath.split(/[?#]/, 1)[0] ?? "";
  const fileName = cleanPath.split(/[\\/]/).at(-1) ?? "";
  if (!fileName) return undefined;

  const namedLanguage = lang(fileName);
  if (namedLanguage) return namedLanguage;

  const extensionStart = fileName.lastIndexOf(".");
  if (extensionStart < 0) return undefined;

  const extension = fileName.slice(extensionStart + 1).toLowerCase();
  if (extension === "svelte") return "html";
  return lang(extension);
}

/** Read and ls share an ACP kind, so the title keeps directory listings unhighlighted. */
export function languageForReadTool(kind: string, title: string, path?: string): LanguageName | undefined {
  if (kind !== "read" || !/^read(?:\s|$)/i.test(title)) return undefined;
  return languageForFilePath(path ?? title.replace(/^read\s*/i, ""));
}
