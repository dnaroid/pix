import type { SqlDatabase } from "./semantic-index-writer.js";

export type WorkSource = "code" | "knowledge" | "settings" | "sessions" | "tasks" | "commits";
export const SOURCE_FILES: Readonly<Record<WorkSource, string>>;
export const WORK_TTL_MS: number;
export const PROVIDER_CONCURRENCY: number;
export class SearchWorkNeedsContinueError extends Error { readonly code: string; constructor(); }
export function automaticWorkPaused(root: string, source: WorkSource, signal: AbortSignal): Promise<boolean>;
export function sourcePath(root: string, source: WorkSource): string;
export function globalSearchDirectory(): string;
export function sourceDirectories(root: string, source: WorkSource): string[];
export function safeFile(filename: string): Promise<void>;
export function safeDirectory(directory: string): Promise<void>;
export function openDatabase(filename: string, options?: { readOnly?: boolean }): Promise<SqlDatabase>;
export function ensureWorkSchema(db: SqlDatabase): void;
export function beginWrite(db: SqlDatabase, signal: AbortSignal, budget?: number): Promise<void>;
export function claimWork(db: SqlDatabase, signal: AbortSignal, options?: { id?: string; retry?: boolean; ttl?: number; waitMs?: number }): Promise<{
  assert(connection: SqlDatabase): void;
  network(connection: SqlDatabase): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
  release(success?: boolean): Promise<void>;
}>;
export function withProviderSlot<T>(signal: AbortSignal, operation: () => Promise<T>,
  options?: { directory?: string; ttl?: number }): Promise<T>;
