import type { ProjectFileRequest } from "./project-explorer-history.svelte";
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
  if (request.type === "copy") {
    const sources = request.sourceWorkspace && request.sourceWorkspace !== workspace ? [] : request.paths.map(tree);
    // Copy names are allocated by the backend, so reserve the destination tree.
    return [tree(request.destination), ...sources];
  }
  return [tree("")];
}
