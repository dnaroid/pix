import type { FederatedSource, FederatedRerankContext, FederatedRerankRequest, FederatedRerankResponse } from "./native-contract.js";
export interface FederationRerankerDependencies {
  signal?: AbortSignal;
  rerankerKey?: () => Promise<string | undefined>;
  rerank?: (query: string, documents: string[], model: string, key: string, signal: AbortSignal) => Promise<unknown>;
}
export function prepareFederatedRerank(root: string, sources: readonly FederatedSource[], signal?: AbortSignal): Promise<{ context?: FederatedRerankContext }>;
export function rerankFederated(root: string, request: FederatedRerankRequest, dependencies?: FederationRerankerDependencies): Promise<FederatedRerankResponse>;
