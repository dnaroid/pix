// Keep existing TS callers compatible while node:test fixtures import the same
// implementation without requiring a TypeScript loader.
export { removeDirsWithRetry, unlinkWithRetry, renameWithRetry, withFilesystemRetry } from "./fs-retry.mjs";
