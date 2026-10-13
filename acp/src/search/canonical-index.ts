import { sourcePath } from "./source-work.js";

/** Settings metadata is user-global; project content stays project-owned. */
export function canonicalSearchIndexPath(cwd: string, source: "settings" | "sessions" | "tasks" | "commits" = "settings"): string {
  return sourcePath(cwd, source);
}
