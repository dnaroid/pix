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

/** Keep source and line navigation intact even when token highlighting is too expensive. */
export function highlightCode(code: string, languageHint?: string): HighlightedCode {
  let language: CodeLanguage = "plaintext";
  if (code.length <= MAX_HIGHLIGHT_CHARS && languageHint) {
    language = /^(gd|gdscript)$/i.test(languageHint) ? "gdscript" : lang(languageHint) ?? "plaintext";
  }
  let html: string;
  if (language === "plaintext") {
    html = code.split("\n").map((line) => `<span class="sh__line">${escapeHtml(line)}</span>`).join("\n");
  } else if (language === "gdscript") {
    html = highlightGDScript(code);
  } else {
    html = highlight(code, { lang: language });
  }
  return { html, language };
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
  if (extension === "gd") return "gdscript";
  if (extension === "svelte") return "html";
  return lang(extension);
}

/** Read and ls share an ACP kind, so the title keeps directory listings unhighlighted. */
export function languageForReadTool(kind: string, title: string, path?: string): CodeLanguage | undefined {
  if (kind !== "read" || !/^read(?:\s|$)/i.test(title)) return undefined;
  return languageForFilePath(path ?? title.replace(/^read\s*/i, "").replace(/:\d+(?:\+\d+)?$/, ""));
}
