import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadLspConfig } from "./_shared/config";
import { findProjectRoot } from "./_shared/paths";
import { getGlobalLspManager } from "./manager";

export type LspControlAction = "status" | "start" | "stop" | "restart" | "trust";
export interface LspRuntimeSnapshot {
  servers: Array<{ id: string; root: string; state: "stopped" | "starting" | "running" | "stopping" | "failed"; pid?: number; error?: string }>;
  warnings: string[];
  trustRequired?: boolean;
}

/** Status never prompts for trust; explicit Start/Restart uses the normal gate. */
export async function controlLocalLsp(ctx: ExtensionContext, action: LspControlAction, id?: string, root?: string): Promise<LspRuntimeSnapshot> {
  const manager = getGlobalLspManager();
  const generation = manager.ownerGeneration;
  const stopRevision = id && root ? manager.stopRevision(id, root) : 0;
  // Stop remains available after config removal or revocation, without asking
  // for permission to execute a config that is no longer trusted.
  if (action === "stop") {
    if (!id || !root) throw new Error("LSP stop requires server id and root");
    await manager.stopServer(id, root);
  }
  const loaded = await loadLspConfig(action === "start" || action === "restart" || action === "trust" ? ctx : { ...ctx, hasUI: false });
  const warnings = [...loaded.warnings];
  const workspace = loaded.layers.find((layer) => layer.scope === "project")?.dir;
  if (action === "start" || action === "restart") {
    const knownRoots = manager.runtimeSnapshot();
    const configured = loaded.items.flatMap((server) => {
      const serverRoot = findProjectRoot(ctx.cwd, server.rootMarkers, ctx.cwd);
      const roots = new Set(serverRoot ? [serverRoot] : []);
      // Internal lifecycle restarts revalidate previously discovered roots.
      for (const known of knownRoots) {
        if (known.id === server.id && findProjectRoot(known.root, server.rootMarkers, ctx.cwd) === known.root) roots.add(known.root);
      }
      return [...roots].map((root) => ({ server, root }));
    });
    const target = configured.find((item) => item.server.id === id && item.root === root);
    if (!target) throw new Error("LSP server/root is not available in trusted workspace configuration");
    const commandValues = [target.server.bin, ...(target.server.args ?? []), target.server.cwd ?? "", target.server.config ?? "", ...Object.values(target.server.env ?? {})];
    if (commandValues.some((value) => /\{(?:file|relFile|dir|relDir)\}/.test(value))) {
      throw new Error("This LSP command needs a file path; use the file-based LSP tools to start it");
    }
    if (generation !== manager.ownerGeneration) throw new Error("LSP owner stopped");
    if (stopRevision !== manager.stopRevision(target.server.id, target.root)) throw new Error("LSP start cancelled by Stop");
    if (action === "restart") {
      await manager.stopServer(target.server.id, target.root);
      if (generation !== manager.ownerGeneration) throw new Error("LSP owner stopped");
      // Our own Stop advances the revision once. Any later Stop must win over
      // this pending Restart rather than being undone when shutdown completes.
      if (manager.stopRevision(target.server.id, target.root) !== stopRevision + 1) throw new Error("LSP restart cancelled by Stop");
    }
    await manager.startServer(target.server, target.root, workspace ? path.dirname(workspace) : ctx.cwd, generation);
  }
  return { servers: manager.runtimeSnapshot(), warnings, trustRequired: loaded.trustRequired };
}
