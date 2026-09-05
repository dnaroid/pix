/** Runtime-only optimistic concurrency tokens; never serialize these into user state. */
export interface DcpDiskRevision {
  generation: number;
  payloadHash: string;
}

const revisions = new WeakMap<object, Map<string, DcpDiskRevision>>();

export function dcpDiskRevisions(owner: object): Map<string, DcpDiskRevision> {
  let known = revisions.get(owner);
  if (!known) {
    known = new Map();
    revisions.set(owner, known);
  }
  return known;
}

/** A detached transaction belongs to its original owner, not a new file writer. */
export function shareDcpDiskRevisions(source: object, destination: object): void {
  revisions.set(destination, dcpDiskRevisions(source));
}

/** Restoring the same loaded payload twice creates independent optimistic owners. */
export function restoreDcpDiskRevisions(source: object, destination: object): void {
  revisions.set(destination, new Map(
    [...dcpDiskRevisions(source)].map(([path, revision]) => [path, { ...revision }]),
  ));
}

export function resetDcpDiskRevisions(owner: object): void {
  revisions.delete(owner);
}
