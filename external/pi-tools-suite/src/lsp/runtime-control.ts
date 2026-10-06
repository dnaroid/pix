import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approvedLspConfig, attachSharedLsp, canonicalLspContext, canonicalLspRoot } from "./shared-manager";
import type { LspBrokerInspection } from "./broker-client";
export type { LspControlAction, LspRuntimeSnapshot } from "./local-runtime-control";
import type { LspControlAction, LspRuntimeSnapshot } from "./local-runtime-control";
import { controlLocalLsp } from "./local-runtime-control";

/** Only the caller can prompt/load trust. Broker sees approved data, never UI. */
export async function controlLsp(ctx: ExtensionContext, action: LspControlAction, id?: string, root?: string): Promise<LspRuntimeSnapshot> {
  if (process.platform === "win32") return controlLocalLsp(ctx, action, id, root);
  ctx = canonicalLspContext(ctx);
  if (root) root = canonicalLspRoot(root);
  const connection = await attachSharedLsp(ctx);
  // Capture the broker's fence BEFORE the asynchronous local trust decision.
  let state = action === "start" || action === "restart"
    ? await connection.rpc<LspBrokerInspection>({ op: "inspect", targetId: id, root }, ctx.signal, 5_000)
    : undefined;
  const stamp = state ? { generation: state.generation, revision: state.revision } : undefined;
  if (action === "stop") {
    if (!id || !root) throw new Error("LSP stop requires server id and root");
    state = await connection.rpc<LspBrokerInspection>({ op: "stop", targetId: id, root }, ctx.signal, 5_000);
  }
  const config = await approvedLspConfig(action === "start" || action === "restart" || action === "trust" ? ctx : { ...ctx, hasUI: false });
  if (action === "start" || action === "restart") {
    state = await connection.rpc<LspBrokerInspection>({ op: action, cwd: ctx.cwd, config, targetId: id, root, stamp }, ctx.signal);
  } else state = await connection.rpc<LspBrokerInspection>({ op: "inspect" }, ctx.signal, 5_000);
  const warnings = [...config.warnings];
  return { servers: state.servers, warnings, trustRequired: config.trustRequired };
}

/** Public panels inspect real processes, not configuration or stopped records. */
export async function monitorLsp(ctx: ExtensionContext): Promise<LspRuntimeSnapshot> {
  const snapshot = await controlLsp(ctx, "status");
  const warnings = [...snapshot.warnings];
  for (const server of snapshot.servers) {
    if (server.state === "failed" && server.error) warnings.push(`${server.id} (${server.root}): ${server.error}`);
  }
  return {
    ...snapshot,
    servers: snapshot.servers.filter((server) => server.state === "starting" || server.state === "running" || server.state === "stopping"),
    warnings,
  };
}
