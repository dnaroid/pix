import { join, resolve } from "node:path";

/** One durable, project-owned SQLite file for Pix search domains.
 *
 * Namespaced table families keep settings/commits/sessions separate.
 * Project Clean and the background TTL preserve this entire directory.
 */
export function canonicalSearchIndexPath(cwd: string, source: "settings" | "sessions" | "tasks" | "commits" = "settings"): string {
  return join(resolve(cwd), ".pi", "search", source === "commits" ? "git-commits.sqlite" : `${source}.sqlite`);
}
