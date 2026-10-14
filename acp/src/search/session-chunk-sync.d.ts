export class SessionChunkSync {
  constructor(run: (signal: AbortSignal) => Promise<unknown>,signal: AbortSignal,failed?: (error: unknown) => void);
  readonly worker?: Promise<unknown>;
  readonly failureBackoffMs: number;
  changed(): void;
  noteIncomplete(): void;
  start(): void;
  dispose(): Promise<void>;
}
