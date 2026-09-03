import { highlight, type LanguageName } from "sugar-high";
import { lang } from "sugar-high/lang";

export interface HighlightedCode {
  readonly html: string;
  readonly language: LanguageName;
}

/** Highlight code with a fast plaintext fallback when the hint is unknown. */
export function highlightCode(code: string, languageHint?: string): HighlightedCode {
  const language = languageHint ? lang(languageHint) ?? "plaintext" : "plaintext";
  return {
    html: highlight(code, { lang: language }),
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
