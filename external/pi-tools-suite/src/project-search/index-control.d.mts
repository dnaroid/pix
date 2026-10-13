import type { ManualRequest, ManualReply, ManualTarget, ManualResult } from "./managed-index-run.mjs";
export const MANUAL_RUN_TTL: number;
export interface ManualRun { state: string; started: number; updated: number; result?: ManualResult<ManualTarget>;
  receipt?: { source: string; index: string; checkedAt: number; complete: boolean } }
export function readManualRuns(root: string): Promise<Partial<Record<ManualTarget, ManualRun>>>;
export function controlManualIndex(root: string, request: ManualRequest): Promise<ManualReply>;
