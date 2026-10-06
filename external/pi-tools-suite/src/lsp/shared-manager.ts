import path from "node:path";
import fs from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadLspConfig } from "./_shared/config";
import { connectLspBroker, type LspBrokerConnection } from "./broker-client";
import { lspProjectIdentity } from "./broker-identity";
import type { ApprovedLspConfig } from "./manager";
import { getGlobalLspManager } from "./manager";

interface Attachment { project: string; alive: boolean; connection: Promise<LspBrokerConnection> }
// Pi's TS loader can evaluate .js/extensionless/.ts imports separately. Ownership
// must still be process-global, otherwise shutdown/switch misses hidden peers.
const globalState = globalThis as typeof globalThis & { __piToolsSuiteLspAttachments?: Map<object | string, Attachment> };
const owners = globalState.__piToolsSuiteLspAttachments ??= new Map<object | string, Attachment>();
const ownerKey = (ctx: Pick<ExtensionContext, "sessionManager">) => ctx.sessionManager ?? "default";

export function canonicalLspContext(ctx: ExtensionContext): ExtensionContext {
  return Object.create(ctx, { cwd: { value: fs.realpathSync(ctx.cwd), enumerable: true } });
}

export function canonicalLspRoot(root: string): string {
  try { return fs.realpathSync(root); }
  catch (error) {
    // Stop remains available for a previously owned root deleted from disk.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return root;
    throw error;
  }
}

export async function attachSharedLsp(ctx: ExtensionContext): Promise<LspBrokerConnection> {
  const key = ownerKey(ctx);
  const project = lspProjectIdentity(ctx.cwd);
  let attachment = owners.get(key);
  if (attachment && (attachment.project !== project || !attachment.alive)) {
    attachment.alive = false;
    void attachment.connection.then((connection) => connection.close()).catch(() => {});
    owners.delete(key); attachment = undefined;
  }
  if (!attachment) {
    attachment = { project, alive: true, connection: connectLspBroker(ctx.cwd) };
    owners.set(key, attachment);
  }
  const current = attachment;
  try {
    const connection = await current.connection;
    if (!current.alive) { await connection.close(); throw new Error("LSP owner stopped"); }
    if (connection.isClosed) {
      if (owners.get(key) === current) owners.delete(key);
      return attachSharedLsp(ctx);
    }
    return connection;
  } catch (error) { if (owners.get(key) === current) owners.delete(key); throw error; }
}

export async function releaseSharedLsp(ctx?: Pick<ExtensionContext, "sessionManager">): Promise<void> {
  if (process.platform === "win32") { await getGlobalLspManager().shutdownAll(); return; }
  const attachments = ctx ? [owners.get(ownerKey(ctx))].filter((item): item is Attachment => !!item) : [...owners.values()];
  if (ctx) owners.delete(ownerKey(ctx)); else owners.clear();
  for (const attachment of attachments) attachment.alive = false;
  await Promise.all(attachments.map((attachment) => attachment.connection.then((connection) => connection.close()).catch(() => {})));
}

export async function approvedLspConfig(ctx: ExtensionContext): Promise<ApprovedLspConfig & { trustRequired: boolean }> {
  const loaded = await loadLspConfig(ctx);
  const projectLayer = loaded.layers.find((layer) => layer.scope === "project");
  return { items: loaded.items, warnings: loaded.warnings, trustRequired: loaded.trustRequired, workspace: projectLayer ? path.dirname(projectLayer.dir) : ctx.cwd };
}

export async function sharedDiagnosticsForFile(ctx: ExtensionContext, file: string): Promise<string> {
  if (process.platform === "win32") return getGlobalLspManager().updateDiagnosticsForFile(ctx, file);
  ctx = canonicalLspContext(ctx);
  file = fs.realpathSync(file);
  const connection = await attachSharedLsp(ctx);
  const config = await approvedLspConfig(ctx);
  return connection.rpc<string>({ op: "diagnostics", cwd: ctx.cwd, file, config }, ctx.signal);
}
