export const SESSION_PASS_WORK: string;
export type SessionPassDeferral = "lease_held" | "busy";
export function isSessionIndexBusy(error: unknown): boolean;
export function withSessionPass<T>(root: string, signal: AbortSignal, run: () => Promise<T>): Promise<{ value: T; deferred?: undefined } | { deferred: SessionPassDeferral; value?: undefined }>;
