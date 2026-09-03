import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AcpExit, AcpTransport, AcpTransportHandlers } from "./acp-client";

export class TauriAcpTransport implements AcpTransport {
  private unlisten: UnlistenFn[] = [];
  private started = false;
  private generation: number | null = null;

  async start(handlers: AcpTransportHandlers): Promise<void> {
    if (this.started) return;
    const earlyEvents: Array<{ generation: number; deliver: () => void }> = [];
    const deliver = (generation: number, callback: () => void): void => {
      if (this.generation === generation) callback();
      else if (this.generation === null) earlyEvents.push({ generation, deliver: callback });
    };
    try {
      this.unlisten.push(
        await listen<AcpLine>("acp://stdout", (event) =>
          deliver(event.payload.generation, () => handlers.onLine(event.payload.line))),
        await listen<AcpLine>("acp://stderr", (event) =>
          deliver(event.payload.generation, () => handlers.onStderr(event.payload.line))),
        await listen<AcpExit>("acp://exit", (event) =>
          deliver(event.payload.generation, () => handlers.onExit(event.payload))),
      );
      this.generation = await invoke<number>("acp_start");
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
    return invoke("acp_send", { generation: this.generation, line });
  }

  async stop(): Promise<void> {
    this.removeListeners();
    if (!this.started) return;
    const generation = this.generation;
    this.started = false;
    this.generation = null;
    await invoke("acp_stop", { generation });
  }

  private removeListeners(): void {
    for (const unlisten of this.unlisten.splice(0)) unlisten();
  }
}

interface AcpLine {
  readonly generation: number;
  readonly line: string;
}
