export type SearchSource = "settings" | "code" | "knowledge" | "sessions" | "tasks" | "commits";
export type SourceSelection = Record<SearchSource, boolean>;
export interface SourcePolicy { enabled: SourceSelection; error?: string; revision?: string }
export const SEARCH_SOURCES: readonly SearchSource[];
export const DEFAULT_SEARCH_SOURCES: Readonly<SourceSelection>;
export function sourcePolicyPath(root: string): string;
export function replaceWorkspaceConfig(root: string, content: string, verify: () => Promise<void>): Promise<string>;
export function readSourcePolicy(root: string): Promise<SourcePolicy>;
export function sourceEnabled(root: string, source: SearchSource, revision?: string): Promise<boolean>;
export function requireSourceEnabled(root: string, source: SearchSource, signal?: AbortSignal, revision?: string): Promise<void>;
export function writeSourcePolicy(root: string, source: SearchSource, enabled: boolean): Promise<SourcePolicy>;
export function watchSourcePolicy(root: string, changed: () => void): () => void;
export function withSourcePolicy<T>(root: string, caller: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
