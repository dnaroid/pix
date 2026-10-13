export type ManualSource = "code" | "knowledge" | "settings" | "sessions" | "tasks" | "commits";
export type ManualTarget = ManualSource | "all";
export interface ManualResult<S extends ManualTarget = ManualSource> { source: S; complete: boolean; indexed?: number; total?: number; message?: string }
export interface ManualRequest { action: "begin" | "heartbeat" | "finish" | "stop"; source: ManualTarget; token?: string; settingsDigest?: string; result?: ManualResult<ManualTarget>; cancelled?: boolean }
export interface ManualReply { accepted: boolean; token?: string; stop?: boolean; result?: ManualResult<ManualTarget>; state?: string }
export function runManagedIndex<S extends ManualTarget>(control: (request: ManualRequest) => Promise<ManualReply>, source: S,
  signal: AbortSignal, run: (signal: AbortSignal, check: () => Promise<void>) => Promise<ManualResult<S>>, settingsDigest?: string, heartbeatMs?: number): Promise<ManualResult<S>>;
