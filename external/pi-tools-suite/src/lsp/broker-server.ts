import fs from "node:fs";
import net, { type Socket } from "node:net";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LspManager, type ApprovedLspConfig } from "./manager";
import { findProjectRoot } from "./_shared/paths";
import { lspProjectIdentity, verifyLspSocket } from "./broker-identity";
import { LSP_RPC_MAX_PENDING, LSP_RPC_TIMEOUT_MS, receiveLspFrames, sendLspFrame } from "./broker-wire";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function probeEndpoint(endpoint: string): Promise<boolean> {
  verifyLspSocket(endpoint);
  return new Promise<boolean>((resolve, reject) => {
    const probe = net.createConnection(endpoint);
    const timer = setTimeout(() => { probe.destroy(); reject(new Error("LSP endpoint probe timed out")); }, 500);
    probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(true); });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false); else reject(error);
    });
  });
}

/** Retain ownership through process exit so a retiring broker cannot unlink its successor. */
async function bindBroker(server: net.Server, endpoint: string): Promise<boolean> {
  const lock = `${endpoint}.lock`;
  const deadline = Date.now() + 10_000;
  let fd: number | undefined;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, "wx", 0o600); fs.writeSync(fd, String(process.pid)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = fs.lstatSync(lock);
        if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw new Error("Unsafe LSP ownership lock");
        const pid = Number(fs.readFileSync(lock, "utf8"));
        let dead = false;
        if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === "ESRCH"; } }
        else dead = Date.now() - stat.mtimeMs > 5_000;
        if (dead && fs.lstatSync(lock).ino === stat.ino) { fs.unlinkSync(lock); continue; }
        // Concurrent launch contenders exit instead of waiting out an active owner.
        if (!dead && fs.existsSync(endpoint) && await probeEndpoint(endpoint)) return false;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if (Date.now() >= deadline) throw new Error("LSP broker startup lock timed out");
      await sleep(25);
    }
  }
  const inode = fs.fstatSync(fd).ino;
  let retained = false;
  const release = () => {
    fs.closeSync(fd!);
    try { if (fs.lstatSync(lock).ino === inode) fs.unlinkSync(lock); } catch {}
  };
  try {
    if (fs.existsSync(endpoint)) {
      verifyLspSocket(endpoint);
      const inode = fs.lstatSync(endpoint).ino;
      const live = await probeEndpoint(endpoint);
      if (live) return false;
      // Never sweep a replacement endpoint observed after the asynchronous probe.
      if (fs.existsSync(endpoint)) {
        if (fs.lstatSync(endpoint).ino !== inode) return false;
        fs.unlinkSync(endpoint);
      }
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => { server.off("error", reject); resolve(); });
    });
    fs.chmodSync(endpoint, 0o600);
    // Recovery removes this record only after the PID is gone, not from an exit
    // callback that runs before native socket teardown has finished.
    process.once("exit", () => fs.closeSync(fd!));
    retained = true;
    return true;
  } finally { if (!retained) release(); }
}

export async function runLspBroker(project: string, endpoint: string): Promise<void> {
  process.umask(0o077);
  const approved = new WeakMap<ExtensionContext, ApprovedLspConfig>();
  const manager = new LspManager(async (ctx) => {
    const snapshot = approved.get(ctx);
    if (!snapshot) throw new Error("Missing approved LSP configuration");
    return snapshot;
  });
  const peers = new Set<Socket>();
  const sockets = new Set<Socket>();
  const documentQueues = new Map<string, Promise<unknown>>();
  let closing = false;
  let everAttached = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let endpointInode: number | undefined;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearTimeout(idle);
    for (const peer of sockets) peer.destroy();
    const force = setTimeout(() => { manager.shutdownAllSync(); server.close(); process.exit(0); }, 3_000);
    force.unref();
    await manager.shutdownAll();
    manager.shutdownAllSync();
    server.close();
    try { if (endpointInode === fs.lstatSync(endpoint).ino) fs.unlinkSync(endpoint); } catch {}
    process.exit(0);
  };
  const scheduleShutdown = () => {
    clearTimeout(idle);
    if (peers.size === 0) {
      if (everAttached) void shutdown();
      else idle = setTimeout(() => void shutdown(), 10_000);
    }
  };
  const inspect = (id?: string, root?: string) => ({ servers: manager.runtimeSnapshot(), generation: manager.ownerGeneration, revision: id && root ? manager.stopRevision(id, root) : 0, brokerPid: process.pid });
  const server = net.createServer((socket) => {
    if (closing || sockets.size >= LSP_RPC_MAX_PENDING) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("error", () => {});
    const requests = new Map<number, AbortController>();
    let attached = false;
    const helloTimer = setTimeout(() => socket.destroy(), 2_000);
    socket.once("close", () => {
      clearTimeout(helloTimer);
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      sockets.delete(socket);
      peers.delete(socket);
      scheduleShutdown();
    });
    receiveLspFrames(socket, (message) => {
      if (message?.op === "cancel") { requests.get(message.id)?.abort(); return; }
      if (!Number.isSafeInteger(message?.id) || requests.has(message.id) || requests.size >= LSP_RPC_MAX_PENDING) { socket.destroy(); return; }
      const controller = new AbortController();
      requests.set(message.id, controller);
      const timer = setTimeout(() => controller.abort(), LSP_RPC_TIMEOUT_MS);
      const respond = (response: unknown) => { if (!socket.destroyed) { try { sendLspFrame(socket, response); } catch { socket.destroy(); } } };
      void (async () => {
        if (message.op === "attach") {
          if (message.project !== project) throw new Error("LSP project identity mismatch");
          attached = true; everAttached = true; clearTimeout(helloTimer); clearTimeout(idle); peers.add(socket);
          return inspect();
        }
        if (!attached || closing) throw new Error("LSP owner stopped");
        if (message.op === "detach") {
          // Remove immediately and fence all outstanding starts before replying.
          attached = false;
          for (const [id, pending] of requests) if (id !== message.id) pending.abort();
          peers.delete(socket); scheduleShutdown();
          return true;
        }
        if (message.op === "inspect") return inspect(message.targetId, message.root);
        if (message.op === "stop") {
          if (!message.targetId || typeof message.root !== "string") throw new Error("LSP stop requires server id and root");
          await manager.stopServer(message.targetId, message.root);
          return inspect();
        }
        if (message.op !== "start" && message.op !== "restart" && message.op !== "diagnostics") throw new Error("Unknown LSP operation");
        if (typeof message.cwd !== "string" || lspProjectIdentity(message.cwd) !== project) throw new Error("LSP project identity mismatch");
        const config: ApprovedLspConfig = message.config;
        if (!config || !Array.isArray(config.items) || !Array.isArray(config.warnings) || typeof config.workspace !== "string") throw new Error("Invalid approved LSP configuration");
        const ctx = { cwd: message.cwd, signal: controller.signal } as ExtensionContext;
        approved.set(ctx, config);
        const generation = manager.ownerGeneration;
        if (message.op === "diagnostics") {
          if (typeof message.file !== "string") throw new Error("Invalid diagnostics path");
          // Full refresh is serialized for the same document: clearing diagnostics
          // and version waits must not invalidate another client's in-flight read.
          const previous = documentQueues.get(message.file) ?? Promise.resolve();
          const work = previous.catch(() => {}).then(() => {
            if (controller.signal.aborted || !attached || generation !== manager.ownerGeneration) throw new Error("LSP operation aborted");
            return manager.updateDiagnosticsForFile(ctx, message.file);
          });
          documentQueues.set(message.file, work);
          try { return await work; }
          finally { if (documentQueues.get(message.file) === work) documentQueues.delete(message.file); }
        }
        const serverConfig = config.items.find((item) => item.id === message.targetId && item.enabled !== false);
        const known = manager.runtimeSnapshot().some((item) => item.id === message.targetId && item.root === message.root);
        if (!serverConfig || typeof message.root !== "string" || (!known && findProjectRoot(message.cwd, serverConfig.rootMarkers, message.cwd) !== message.root) || findProjectRoot(message.root, serverConfig.rootMarkers, message.cwd) !== message.root) throw new Error("LSP server/root is not available in trusted workspace configuration");
        const values = [serverConfig.bin, ...(serverConfig.args ?? []), serverConfig.cwd ?? "", serverConfig.config ?? "", ...Object.values(serverConfig.env ?? {})];
        if (values.some((value) => /\{(?:file|relFile|dir|relDir)\}/.test(value))) throw new Error("This LSP command needs a file path; use the file-based LSP tools to start it");
        const revision = manager.stopRevision(serverConfig.id, message.root);
        if (generation !== message.stamp?.generation) throw new Error("LSP owner stopped");
        if (revision !== message.stamp?.revision) throw new Error("LSP start cancelled by Stop");
        if (message.op === "restart") {
          await manager.stopServer(serverConfig.id, message.root);
          if (manager.stopRevision(serverConfig.id, message.root) !== revision + 1) throw new Error("LSP restart cancelled by Stop");
        }
        if (controller.signal.aborted || !attached || generation !== manager.ownerGeneration) throw new Error("LSP owner stopped");
        await manager.startServer(serverConfig, message.root, config.workspace, generation, controller.signal);
        return inspect();
      })().then((result) => respond({ id: message.id, result }), (error) => respond({ id: message.id, error: String(error?.message ?? error) }))
        .finally(() => { clearTimeout(timer); requests.delete(message.id); });
    });
  });
  if (!await bindBroker(server, endpoint)) { manager.shutdownAllSync(); process.exit(0); }
  endpointInode = fs.lstatSync(endpoint).ino;
  server.on("error", () => void shutdown());
  scheduleShutdown();
}
