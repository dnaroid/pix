export function ensureSessionRevision(db: { exec(sql: string): unknown; prepare(sql: string): any }): void;
export function readSessionIndexRevision(root: string, signal: AbortSignal): Promise<{present: boolean; index: string}>;
