import type { ProjectFilePreview } from "./project-files";
import type { ProjectTreeEntry } from "./project-tree";
import { previewMediaKindForPath } from "./media";

function label(text: string): string {
  return text.replace(/[\r\n]/gu, " ").replace(/&/gu, "&amp;").replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;").replace(/[\\`*_[\]{}()#!|]/gu, "\\$&");
}

function destination(name: string): string {
  return `./${encodeURIComponent(name).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** One listing, no recursive IO or on-disk index. Only immediate children are linked. */
export function createWikiContents(directory: string, entries: readonly ProjectTreeEntry[]): ProjectFilePreview {
  const children = entries.filter((entry) => entry.path === `${directory}/${entry.name}`
    && !/[\/\\]/u.test(entry.name) && entry.name !== "." && entry.name !== "..");
  const ordered = [...children].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
  const sections = ordered.filter((entry) => entry.kind === "directory");
  const pages = ordered.filter((entry) => entry.kind === "file" && /\.(?:md|markdown)$/iu.test(entry.name));
  const files = ordered.filter((entry) => entry.kind === "file" && !/\.(?:md|markdown)$/iu.test(entry.name));
  const media: ProjectTreeEntry[] = [];
  const otherFiles: ProjectTreeEntry[] = [];
  for (const entry of files) {
    const kind = previewMediaKindForPath(entry.name);
    if (kind === "image" || kind === "video") media.push(entry);
    else otherFiles.push(entry);
  }
  const lines = [`# ${label(directory.split("/").at(-1) ?? directory)}`, "", "Automatically generated contents. No index file has been created.", ""];
  for (const [title, group] of [["Sections", sections], ["Pages", pages], ["Files", otherFiles]] as const) {
    if (!group.length) continue;
    lines.push(`## ${title}`, "");
    for (const entry of group) {
      const title = entry.kind === "file" ? entry.name.replace(/\.(?:md|markdown)$/iu, "") : entry.name;
      lines.push(`- [${label(title)}](${destination(entry.name)})`);
    }
    lines.push("");
  }
  if (media.length) {
    lines.push("## Media", "");
    for (const entry of media) lines.push(`![${label(entry.name)}](${destination(entry.name)})`, "");
  }
  if (!sections.length && !pages.length && !files.length) lines.push("This folder is empty.", "");
  return { path: `${directory}/index.md`, content: lines.join("\n"), virtualWikiDirectory: directory };
}
