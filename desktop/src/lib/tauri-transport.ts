import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AcpTransport, AcpTransportHandlers } from "./acp-client";

export class TauriAcpTransport implements AcpTransport {
  private unlisten: UnlistenFn[] = [];
  private started = false;
  private generation: number | null = null;
  private readonly windowLabel = getCurrentWindow().label;

  async start(handlers: AcpTransportHandlers): Promise<void> {
    if (this.started) return;
    const earlyEvents: Array<{ generation: number; deliver: () => void }> = [];
    const deliver = (generation: number, callback: () => void): void => {
      if (this.generation === generation) callback();
      else if (this.generation === null) earlyEvents.push({ generation, deliver: callback });
    };
    try {
      const [stdoutUnlisten, stderrUnlisten, exitUnlisten] = await Promise.all([
        listen<AcpLines>("acp://stdout", (event) => {
          if (event.payload.windowLabel !== this.windowLabel) return;
          for (const line of payloadLines(event.payload)) {
            deliver(event.payload.generation, () => handlers.onLine(line));
          }
        }),
        listen<AcpLines>("acp://stderr", (event) => {
          if (event.payload.windowLabel !== this.windowLabel) return;
          for (const line of payloadLines(event.payload)) {
            deliver(event.payload.generation, () => handlers.onStderr(line));
          }
        }),
        listen<AcpExitPayload>("acp://exit", (event) => {
          if (event.payload.windowLabel !== this.windowLabel) return;
          deliver(event.payload.generation, () => handlers.onExit(event.payload));
        }),
      ]);
      this.unlisten.push(stdoutUnlisten, stderrUnlisten, exitUnlisten);
      this.generation = await invoke<number>("acp_start", { windowLabel: this.windowLabel });
      this.started = true;
      for (const event of earlyEvents) {
        if (event.generation === this.generation) event.deliver();
      }
    } catch (error) {
      this.removeListeners();
      this.generation = null;
      throw error;
    }
  }

  send(line: string): Promise<void> {
    if (!this.started || this.generation === null) {
      return Promise.reject(new Error("pix-acp transport is not started"));
    }
    return invoke("acp_send", { windowLabel: this.windowLabel, generation: this.generation, line });
  }

  async stop(): Promise<void> {
    this.removeListeners();
    if (!this.started) return;
    const generation = this.generation;
    this.started = false;
    this.generation = null;
    await invoke("acp_stop", { windowLabel: this.windowLabel, generation });
  }

  private removeListeners(): void {
    for (const unlisten of this.unlisten.splice(0)) unlisten();
  }
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
