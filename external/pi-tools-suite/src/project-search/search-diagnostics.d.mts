export function logSearchDiagnostic(root: string, diagnostic: { event: string; sessionId?: string; path?: string; reason?: string; line?: number; code?: string; message?: string }): Promise<void>;
