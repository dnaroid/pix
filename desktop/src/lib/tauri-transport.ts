import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AcpTransport, AcpTransportHandlers } from "./acp-client";

/** Must not exceed the native `MAX_SEND_BATCH_LINES` admission limit. */
const SEND_BATCH_MAX_LINES = 256;
/** Soft byte cap per batch; a single oversized line is still sent alone. */
const SEND_BATCH_MAX_BYTES = 4 * 1024 * 1024;
/** Bound for lines waiting behind an in-flight batch (stalled child stdin). */
const SEND_OUTBOX_MAX_LINES = 4096;

export class TauriAcpTransport implements AcpTransport {
  private run: TransportRun | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private readonly windowLabel = getCurrentWindow().label;

  start(handlers: AcpTransportHandlers): Promise<void> {
    if (this.run) return this.run.ready;
    const run: TransportRun = {
      cancelled: false,
      generation: null,
      unlisten: [],
      ready: Promise.resolve(),
      outbox: [],
      flushing: false,
    };
    this.run = run;
    run.ready = this.startRun(run, handlers, this.stopping);
    return run.ready;
  }

  private async startRun(
    run: TransportRun,
    handlers: AcpTransportHandlers,
    stopping: Promise<void>,
  ): Promise<void> {
    const earlyEvents: Array<{ generation: number; deliver: () => void }> = [];
    const deliver = (generation: number, callback: () => void): void => {
      if (run.cancelled) return;
      if (run.generation === generation) callback();
      else if (run.generation === null) earlyEvents.push({ generation, deliver: callback });
    };
    const trackListener = async (registration: Promise<UnlistenFn>): Promise<void> => {
      const unlisten = await registration;
      // Promise.all may already have failed, or stop() may have cancelled this run.
      if (run.cancelled) unlisten();
      else run.unlisten.push(unlisten);
    };
    try {
      await stopping;
      this.assertCurrent(run);
      await Promise.all([
        trackListener(listen<AcpLines>("acp://stdout", (event) => {
          if (event.payload.windowLabel !== this.windowLabel) return;
          for (const line of payloadLines(event.payload)) {
            deliver(event.payload.generation, () => handlers.onLine(line));
          }
        })),
        trackListener(listen<AcpLines>("acp://stderr", (event) => {
          if (event.payload.windowLabel !== this.windowLabel) return;
          for (const line of payloadLines(event.payload)) {
            deliver(event.payload.generation, () => handlers.onStderr(line));
          }
        })),
        trackListener(listen<AcpExitPayload>("acp://exit", (event) => {
          if (event.payload.windowLabel !== this.windowLabel) return;
          deliver(event.payload.generation, () => handlers.onExit(event.payload));
        })),
      ]);
      this.assertCurrent(run);
      run.generation = await invoke<number>("acp_start", { windowLabel: this.windowLabel });
      this.assertCurrent(run);
      for (const event of earlyEvents) {
        if (!run.cancelled && event.generation === run.generation) event.deliver();
      }
    } catch (error) {
      run.cancelled = true;
      this.removeListeners(run);
      rejectOutbox(run, new Error("pix-acp transport stopped before the write"));
      // A cancelled acp_start can still create a child. Reap its own generation,
      // never a replacement run. stop() also observes any cleanup failure.
      const cleanup = this.stopNative(run);
      if (this.run === run) {
        this.run = null;
        this.stopping = cleanup;
      }
      await cleanup.catch(() => {});
      throw error;
    }
  }

  /**
   * Lines are delivered strictly in call order: one native batch is in flight
   * per run, and lines sent meanwhile coalesce into the next batch. Separate
   * concurrent invokes could be reordered by IPC and saturate native stdin
   * admission under bursts.
   */
  send(line: string): Promise<void> {
    const run = this.run;
    if (!run || run.cancelled || run.generation === null) {
      return Promise.reject(new Error("pix-acp transport is not started"));
    }
    if (run.outbox.length >= SEND_OUTBOX_MAX_LINES) {
      return Promise.reject(new Error("pix-acp stdin is busy; retry the write"));
    }
    return new Promise<void>((resolve, reject) => {
      run.outbox.push({ line, resolve, reject });
      if (!run.flushing) {
        run.flushing = true;
        // Coalesce a synchronous burst of sends into the first batch.
        queueMicrotask(() => void this.flush(run));
      }
    });
  }

  private async flush(run: TransportRun): Promise<void> {
    try {
      while (run.outbox.length > 0) {
        const generation = run.generation;
        if (run.cancelled || generation === null) {
          rejectOutbox(run, new Error("pix-acp transport stopped before the write"));
          return;
        }
        const batch = takeBatch(run.outbox);
        try {
          await invoke("acp_send", { windowLabel: this.windowLabel, generation, lines: batch.map(({ line }) => line) });
          for (const entry of batch) entry.resolve();
        } catch (error) {
          const reason = error instanceof Error ? error : new Error(String(error));
          for (const entry of batch) entry.reject(reason);
        }
      }
    } finally {
      run.flushing = false;
    }
  }

  stop(): Promise<void> {
    const run = this.run;
    if (!run) return this.stopping;
    this.run = null;
    run.cancelled = true;
    this.removeListeners(run);
    rejectOutbox(run, new Error("pix-acp transport stopped before the write"));
    this.stopping = run.ready.catch(() => {}).then(() => this.stopNative(run));
    return this.stopping;
  }

  private assertCurrent(run: TransportRun): void {
    if (run.cancelled || this.run !== run) throw new Error("pix-acp transport start was cancelled");
  }

  private stopNative(run: TransportRun): Promise<void> {
    if (run.stopping) return run.stopping;
    if (run.generation === null) return Promise.resolve();
    const generation = run.generation;
    run.generation = null;
    run.stopping = invoke("acp_stop", { windowLabel: this.windowLabel, generation });
    return run.stopping;
  }

  private removeListeners(run: TransportRun): void {
    for (const unlisten of run.unlisten.splice(0)) unlisten();
  }
}

interface TransportRun {
  cancelled: boolean;
  generation: number | null;
  readonly unlisten: UnlistenFn[];
  ready: Promise<void>;
  stopping?: Promise<void>;
  readonly outbox: OutboxEntry[];
  flushing: boolean;
}

interface OutboxEntry {
  readonly line: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function takeBatch(outbox: OutboxEntry[]): OutboxEntry[] {
  let count = 0;
  let bytes = 0;
  while (count < outbox.length && count < SEND_BATCH_MAX_LINES) {
    // UTF-16 length is a cheap proxy; the native byte budget is authoritative.
    const next = outbox[count]!.line.length + 1;
    if (count > 0 && bytes + next > SEND_BATCH_MAX_BYTES) break;
    bytes += next;
    count += 1;
  }
  return outbox.splice(0, count);
}

function rejectOutbox(run: TransportRun, error: Error): void {
  for (const entry of run.outbox.splice(0)) entry.reject(error);
}

interface AcpLines {
  readonly windowLabel: string;
  readonly generation: number;
  readonly lines?: readonly string[];
  readonly line?: string;
}

interface AcpExitPayload {
  readonly windowLabel: string;
  readonly generation: number;
  readonly code: number | null;
  readonly success: boolean;
  readonly requested: boolean;
  readonly error: string | null;
}

function payloadLines(payload: AcpLines): readonly string[] {
  if (Array.isArray(payload.lines)) return payload.lines.filter((line): line is string => typeof line === "string");
  return typeof payload.line === "string" ? [payload.line] : [];
}
