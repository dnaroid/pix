import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AcpTransport, AcpTransportHandlers } from "./acp-client";

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

  send(line: string): Promise<void> {
    const run = this.run;
    if (!run || run.cancelled || run.generation === null) {
      return Promise.reject(new Error("pix-acp transport is not started"));
    }
    return invoke("acp_send", { windowLabel: this.windowLabel, generation: run.generation, line });
  }

  stop(): Promise<void> {
    const run = this.run;
    if (!run) return this.stopping;
    this.run = null;
    run.cancelled = true;
    this.removeListeners(run);
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
