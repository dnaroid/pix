import type { NativeSearchRequest, NativeSearchResponse } from "../../../external/pi-tools-suite/src/project-search/native-contract";
import type { FederatedRerankContext, FederatedRerankRequest, FederatedRerankResponse, FederatedSource } from "../../../external/pi-tools-suite/src/project-search/native-contract";
import type { IndexResult } from "./search-index-actions";

type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

/** Owned independently of ACP sessions; cancellation also terminates the native child. */
export async function queryNativeRepository(invoke: Invoke, workspace: string, query: NativeSearchRequest,
  signal: AbortSignal): Promise<NativeSearchResponse> {
  return requestNative<NativeSearchResponse>(invoke, workspace, query, signal);
}

export function prepareNativeRerank(invoke: Invoke, workspace: string, sources: FederatedSource[], signal: AbortSignal) {
  return requestNative<{ context?: FederatedRerankContext }>(invoke, workspace, { operation: "rerank-prepare", sources }, signal);
}

export function queryNativeRerank(invoke: Invoke, workspace: string, request: FederatedRerankRequest, signal: AbortSignal) {
  return requestNative<FederatedRerankResponse>(invoke, workspace, { ...request, operation: "rerank" }, signal);
}

export function indexNativeRepository(invoke: Invoke, workspace: string, source: "code" | "knowledge",
  signal: AbortSignal): Promise<IndexResult> {
  return requestNative<IndexResult>(invoke, workspace, { operation: "index", source }, signal);
}

export async function requestNative<T>(invoke: Invoke, workspace: string, query: object, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  const cancel = () => { void invoke("native_project_search_cancel", { requestId }).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await invoke<T>("native_project_search", { request: { workspace, requestId, query } });
    signal.throwIfAborted();
    return response;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
