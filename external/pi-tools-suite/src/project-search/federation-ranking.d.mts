export function selectFederatedCandidates<T extends { kind: string }>(hits: readonly T[], limit?: number): T[];
export function applyFederatedOrder<T extends { kind: string; id: string; score: number }>(candidates: readonly T[], order: unknown): T[] | undefined;
