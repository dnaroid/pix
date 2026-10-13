export const SESSION_MIN_AGE_MS: number;
export const SESSION_RECONCILE_MS: number;
export function sessionCreatedAt(filename: string, info: { birthtimeMs: number }): number | undefined;
export function sessionRevisionDigest(rows: unknown): string;
export function sessionFileRevision(info: unknown): string;
export function regularSessionFile(info: unknown): boolean;
