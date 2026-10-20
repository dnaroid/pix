export function taskSnapshot(filename: string, signal: AbortSignal): Promise<string>;
export interface PlanFile { path: string; content: string }
export function readPlanFiles(root: string, signal: AbortSignal): Promise<PlanFile[]>;
export function taskSourceRevision(root: string, signal: AbortSignal): Promise<string>;
