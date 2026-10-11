export function withFilesystemRetry(operation: () => void, attempts?: number, delayMs?: number): Promise<void>;
export function removeDirsWithRetry(roots: string[], attempts?: number, delayMs?: number): Promise<void>;
export function unlinkWithRetry(filename: string, attempts?: number, delayMs?: number): Promise<void>;
export function renameWithRetry(from: string, to: string, attempts?: number, delayMs?: number): Promise<void>;
