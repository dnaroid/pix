import { isAbsolute, relative, sep } from "node:path";

export function isPathInside(parentPath: string, targetPath: string): boolean {
  const rel = relative(parentPath, targetPath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
