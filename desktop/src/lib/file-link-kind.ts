/** A successful directory check carries its kind through lazy Markdown hydration. */
export type FileLinkValidation = boolean | "directory";

export type FileLinkIconKind = "folder" | "file" | "text" | "code" | "globe" | "image" | "audio" | "video" | "archive" | "pdf";

const extensionGroups: readonly { kind: FileLinkIconKind; extensions: readonly string[] }[] = [
  { kind: "globe", extensions: ["html", "htm"] },
  { kind: "pdf", extensions: ["pdf"] },
  { kind: "text", extensions: ["md", "mdx", "txt", "log", "rst", "csv", "rtf"] },
  { kind: "image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"] },
  { kind: "audio", extensions: ["aac", "aif", "aiff", "flac", "m4a", "m4b", "mp3", "mpga", "oga", "ogg", "opus", "wav", "wave", "weba"] },
  { kind: "video", extensions: ["m4v", "mov", "mp4", "ogv", "webm"] },
  { kind: "archive", extensions: ["zip", "gz", "tgz", "bz2", "xz", "tar", "7z", "rar"] },
  { kind: "code", extensions: [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "css", "scss", "svelte",
    "rs", "py", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp", "sh", "bash", "zsh",
    "yaml", "yml", "toml", "xml", "sql",
  ] },
];

export function fileLinkIconKind(path: string, validation: FileLinkValidation): FileLinkIconKind {
  if (validation === "directory") return "folder";
  const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  if (["dockerfile", "makefile", "gemfile", "rakefile"].includes(name)) return "code";
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  return extensionGroups.find((group) => group.extensions.includes(extension))?.kind ?? "file";
}
