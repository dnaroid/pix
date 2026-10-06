import net, { type Socket } from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lspBrokerEndpoint, lspProjectIdentity, verifyLspSocket } from "./broker-identity";
import { LSP_RPC_MAX_PENDING, LSP_RPC_TIMEOUT_MS, receiveLspFrames, sendLspFrame } from "./broker-wire";

export interface LspBrokerInspection {
  servers: Array<{ id: string; root: string; state: "stopped" | "starting" | "running" | "stopping" | "failed"; pid?: number; error?: string }>;
  generation: number;
  revision: number;
  brokerPid: number;
}

export class LspBrokerConnection {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; cleanup: () => void }>();
  private closed = false;
  constructor(private readonly socket: Socket) {
    receiveLspFrames(socket, (message) => {
      const request = this.pending.get(message?.id);
      if (!request) return;
      this.pending.delete(message.id); request.cleanup();
      if (typeof message.error === "string") request.reject(new Error(message.error));
      else request.resolve(message.result);
    });
    const fail = () => {
      this.closed = true;
      for (const request of this.pending.values()) { request.cleanup(); request.reject(new Error("LSP broker disconnected")); }
      this.pending.clear();
    };
    socket.on("error", fail); socket.once("close", fail);
  }
  get isClosed(): boolean { return this.closed || this.socket.destroyed; }

  rpc<T = unknown>(operation: Record<string, unknown>, signal?: AbortSignal, timeoutMs = LSP_RPC_TIMEOUT_MS): Promise<T> {
    if (this.isClosed) return Promise.reject(new Error("LSP owner stopped"));
    if (signal?.aborted) return Promise.reject(new Error("LSP operation aborted"));
    if (this.pending.size >= LSP_RPC_MAX_PENDING) return Promise.reject(new Error("Too many pending LSP operations"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const cancel = (reason: string) => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id); request.cleanup();
        try { sendLspFrame(this.socket, { op: "cancel", id }); } catch {}
        reject(new Error(reason));
      };
      const abort = () => cancel("LSP operation aborted");
      const timer = setTimeout(() => cancel("LSP RPC timed out"), timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try { sendLspFrame(this.socket, { ...operation, id }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  async close(): Promise<void> {
    if (this.isClosed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.rpc({ op: "detach" }), new Promise((resolve) => { timer = setTimeout(resolve, 500); })]);
    } finally { clearTimeout(timer); this.closed = true; this.socket.destroy(); }
  }
}

async function connect(endpoint: string): Promise<Socket> {
  verifyLspSocket(endpoint);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("LSP broker connect timed out")); }, 500);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
  });
}

export async function connectLspBroker(cwd: string): Promise<LspBrokerConnection> {
  const project = lspProjectIdentity(cwd);
  const endpoint = lspBrokerEndpoint(project);
  let launched = false;
  const deadline = Date.now() + 12_000;
  for (;;) {
    try {
      const connection = new LspBrokerConnection(await connect(endpoint));
      try { await connection.rpc({ op: "attach", project }, undefined, 2_000); return connection; }
      catch (error) { await connection.close().catch(() => {}); throw error; }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retiring = /LSP (?:owner stopped|broker disconnected)/.test((error as Error).message);
      if (code !== "ENOENT" && code !== "ECONNREFUSED" && !retiring) throw error;
      if (!launched && !retiring) {
        launched = true;
        const bootstrap = fileURLToPath(new URL("./broker-bootstrap.mjs", import.meta.url));
        // Bun development also exercises the production Node + SDK-jiti bootstrap.
        const node = process.versions.bun ? "node" : process.execPath;
        const child = spawn(node, [bootstrap, project, endpoint], { detached: true, stdio: "ignore", cwd: path.dirname(bootstrap), env: process.env });
        child.on("error", () => {}); child.unref();
      }
      if (Date.now() >= deadline) throw new Error("LSP broker startup timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
