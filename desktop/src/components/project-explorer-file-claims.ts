import type { ProjectFileRequest } from "./project-explorer-history.svelte";
import { projectTreeAbsolutePath } from "../lib/project-tree";
import type { ProjectOperationClaim } from "./project-explorer-operations.svelte";

/** Match the complete batch footprint, including destinations and source trees. */
export function projectFileRequestClaims(request: ProjectFileRequest, workspace: string): ProjectOperationClaim[] {
  const tree = (path: string): ProjectOperationClaim => ({ path, kind: "tree" });
  if (request.type === "delete") return request.paths.map(tree);
  if (request.type === "move") {
    const destination = request.destination ?? "";
    return [
      ...request.paths.map(tree),
      { path: destination, kind: "directory" },
      ...request.paths.map((path) => tree(`${destination ? `${destination}/` : ""}${path.split("/").at(-1)}`)),
    ];
  }
  if (request.type === "copy" || request.type === "importMove") {
    // Finder references use / as their source workspace. Reserve any source
    // inside this workspace too, not just its destination, while copying it.
    const prefix = projectTreeAbsolutePath(workspace, "");
    const root = prefix.slice(0, -1);
    const sources = request.paths.flatMap((path) => {
      const absolute = projectTreeAbsolutePath(request.sourceWorkspace ?? workspace, path);
      if (absolute === root || root.startsWith(`${absolute}/`)) return [tree("")];
      return absolute.startsWith(prefix) ? [tree(absolute.slice(prefix.length))] : [];
    });
    // Copy names are allocated by the backend, so reserve the destination tree.
    return [tree(request.destination), ...sources];
  }
  return [tree("")];
}
