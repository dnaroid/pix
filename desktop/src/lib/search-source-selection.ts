import { invoke } from "@tauri-apps/api/core";
import { requestNative } from "./native-repository-search";
import type { SourcePolicy, SearchSource } from "../../../acp/src/search/source-policy";

export type { SourcePolicy, SearchSource };
export const SEARCH_SOURCE_SELECTION_CHANGED = "pix-search-sources-changed";
const SOURCES: readonly SearchSource[] = ["settings", "code", "knowledge", "sessions", "tasks", "commits"];

function decodePolicy(value: unknown): SourcePolicy {
  const invalid = () => new Error("Invalid search source selection response");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const policy = value as Record<string, unknown>;
  if (!policy.enabled || typeof policy.enabled !== "object" || Array.isArray(policy.enabled)) throw invalid();
  const enabled = policy.enabled as Record<string, unknown>;
  if (Object.keys(enabled).length !== SOURCES.length || SOURCES.some(source => typeof enabled[source] !== "boolean")) throw invalid();
  for (const field of ["error", "revision"] as const) {
    if (policy[field] !== undefined && (typeof policy[field] !== "string" || policy[field].length > 1024)) throw invalid();
  }
  return {
    enabled: Object.fromEntries(SOURCES.map(source => [source, !policy.error && enabled[source] === true])) as SourcePolicy["enabled"],
    ...(typeof policy.error === "string" && policy.error ? { error: policy.error } : {}),
    ...(typeof policy.revision === "string" ? { revision: policy.revision } : {}),
  };
}

export async function readSearchSourceSelection(workspace: string, signal: AbortSignal): Promise<SourcePolicy> {
  const response = await requestNative<unknown>(invoke, workspace, { operation: "source-policy" }, signal);
  signal.throwIfAborted();
  return decodePolicy(response);
}

export async function setSearchSourceSelection(workspace: string, source: SearchSource, enabled: boolean,
  signal: AbortSignal): Promise<SourcePolicy> {
  const response = await requestNative<unknown>(invoke, workspace, { operation: "set-source-policy", source, enabled }, signal);
  signal.throwIfAborted();
  const policy = decodePolicy(response);
  if (policy.error) throw new Error(policy.error);
  window.dispatchEvent(new CustomEvent(SEARCH_SOURCE_SELECTION_CHANGED, { detail: { workspace, global: source === "settings" } }));
  return policy;
}
