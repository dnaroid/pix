export class SourcePolicyLockError extends Error {}
/** Serialize a short JSON policy update. Never run provider work in the callback. */
export function withSourcePolicyWriteLock<T>(root: string, run: () => Promise<T>): Promise<T>;
