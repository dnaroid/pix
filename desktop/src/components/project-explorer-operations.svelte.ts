export type ProjectOperationClaim = { path: string; kind: "tree" | "directory" };
export type ProjectOperation = { claims: ProjectOperationClaim[]; label: string };

function within(path: string, parent: string): boolean {
  return parent === "" || path === parent || path.startsWith(`${parent}/`);
}

function conflicts(left: ProjectOperationClaim, right: ProjectOperationClaim): boolean {
  if (left.kind === "directory" && right.kind === "directory") return false;
  if (left.kind === "directory") return within(left.path, right.path);
  if (right.kind === "directory") return within(right.path, left.path);
  return within(left.path, right.path) || within(right.path, left.path);
}

/** Tree claims exclude overlapping mutations; directory claims only keep a parent alive.
 * Siblings may mutate concurrently. Tokens are invalidated on workspace change/teardown.
 */
export function createProjectExplorerOperations() {
  let active = $state.raw<ProjectOperation[]>([]);

  function canStart(claims: ProjectOperationClaim[]): boolean {
    return !active.some((operation) => operation.claims.some((held) => claims.some((claim) => conflicts(held, claim))));
  }

  function begin(label: string, claims: ProjectOperationClaim[]): ProjectOperation | null {
    if (!canStart(claims)) return null;
    const operation = { label, claims };
    active = [...active, operation];
    return operation;
  }

  function isCurrent(operation: ProjectOperation): boolean {
    return active.includes(operation);
  }

  function finish(operation: ProjectOperation): boolean {
    if (!isCurrent(operation)) return false;
    active = active.filter((item) => item !== operation);
    return true;
  }

  return {
    get active() { return active; },
    canStart,
    begin,
    isCurrent,
    finish,
    invalidate() { active = []; },
  };
}
