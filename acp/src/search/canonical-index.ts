import { join, resolve } from "node:path";

/** One durable, project-owned SQLite file for Pix search domains.
 *
 * Namespaced table families keep settings/commits/sessions separate and reserve
 * IDX's vec_chunks/vector_meta schema for a possible future integration.
 * Project Clean and the background TTL preserve this entire directory.
 */
export function canonicalSearchIndexPath(cwd: string): string {
  return join(resolve(cwd), ".pi", "search", "index.sqlite");
}
