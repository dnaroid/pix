import { fileLinkIconKind } from "./file-link-kind";
import type { ToolItem } from "./transcript-types";

/** Classify once at ingestion; collapsed trails never inspect tool payloads. */
export function imageRead(tool: Pick<ToolItem, "name" | "title" | "kind" | "rawInput" | "path" | "attachments">): boolean {
  const name = (tool.name ?? tool.title.match(/^([^\s:]+)/u)?.[1] ?? tool.kind).split(/[.:/]/u).at(-1)?.toLowerCase();
  if (name !== "read") return false;
  const input = tool.rawInput && typeof tool.rawInput === "object" ? tool.rawInput as Record<string, unknown> : undefined;
  const path = [input?.path, input?.file_path, input?.filePath, tool.path, tool.title.match(/^Read\s+(.+)$/iu)?.[1]]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return (path !== undefined && fileLinkIconKind(path, true) === "image")
    || tool.attachments.some((attachment) => attachment.kind === "image");
}
