/**
 * Pix Desktop sidecar entrypoint.
 *
 * Hosts the Pi coding-agent SDK in a Node process spawned by the Tauri Rust
 * host. Uses our own JSONL dispatcher (see `dispatcher.ts`) that mirrors the
 * SDK's RPC-mode protocol plus a `pix:*` namespace for desktop-only commands
 * like `pix:list_sessions` and `pix:set_cwd`.
 *
 * Why our own dispatcher instead of the SDK's `runRpcMode`? `runRpcMode` has
 * no extension hook for custom commands, so we reimplement the protocol here
 * against the public AgentSession / AgentSessionRuntime APIs.
 *
 * All logging goes to stderr; stdout is reserved for the protocol stream.
 */

import {
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionRuntime,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { runDispatcher } from "./dispatcher.js";
import type { RpcEvent } from "./protocol.js";

function logErr(msg: string): void {
  process.stderr.write(`[pix-sidecar] ${msg}\n`);
}

process.on("uncaughtException", (err) => {
  logErr(`uncaughtException: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason) => {
  logErr(`unhandledRejection: ${String(reason)}`);
});

// -- Runtime setup ---------------------------------------------------------

// The sidecar boots in its own package directory (for Node module resolution)
// and the user's actual workspace is supplied later via `pix:set_cwd`. Until
// then we use process.cwd() as a fallback — the runtime is created against it
// but no user-meaningful work happen until set_cwd lands.
const initialCwd: string = process.cwd();
const agentDir: string = process.env.PIX_SIDECAR_AGENT_DIR ?? getAgentDir();
// Default to persistent so sessions survive restarts. Override with
// PIX_SIDECAR_SESSION_MODE=in-memory for ephemeral testing.
const sessionMode = (process.env.PIX_SIDECAR_SESSION_MODE ?? "persistent") as
  | "in-memory"
  | "persistent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  sessionManager,
  sessionStartEvent,
}) => {
  // Lazy-import the per-cwd services factory. Re-created on every runtime
  // swap so cwd-bound resources (file watchers, working dir, etc.) follow
  // the active workspace.
  const { createAgentSessionServices, createAgentSessionFromServices } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

// Mutable runtime reference. `switchCwd` replaces this with a fresh runtime
// scoped to the new cwd; the dispatcher reads it through a holder, but
// `switchCwd` here keeps the local binding in sync for shutdown.
let runtime: AgentSessionRuntime;

const initialSessionManager =
  sessionMode === "persistent"
    ? SessionManager.continueRecent(initialCwd)
    : SessionManager.inMemory(initialCwd);

runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: initialCwd,
  agentDir,
  sessionManager: initialSessionManager,
});

logErr(
  `starting dispatcher (initialCwd=${initialCwd}, agentDir=${agentDir}, sessions=${sessionMode}, pid=${process.pid})`,
);
logErr(`sidecar ready (sessionId=${runtime.session.sessionId})`);

/** Replace the active runtime with one scoped to a new cwd. */
const switchCwd = async (newCwd: string): Promise<AgentSessionRuntime> => {
  // continueRecent: open most-recent session in newCwd, or create a fresh
  // session bound to that cwd if none exists yet. Either way the resulting
  // SessionManager picks the right session dir under the new workspace.
  const sessionManager =
    sessionMode === "persistent"
      ? SessionManager.continueRecent(newCwd)
      : SessionManager.inMemory(newCwd);

  await runtime.dispose();
  const next = await createAgentSessionRuntime(createRuntime, {
    cwd: newCwd,
    agentDir,
    sessionManager,
  });
  runtime = next;
  logErr(`switched workspace (cwd=${newCwd}, sessionId=${next.session.sessionId})`);
  return next;
};

// Bridge agent events to dispatcher output. Rebind every time the runtime
// swaps sessions (pix:set_cwd / new_session / switch_session) so we never
// emit events from a stale AgentSession.
const onSession = (session: AgentSession, output: (ev: RpcEvent) => void): (() => void) => {
  return session.subscribe((ev) => {
    output(ev as RpcEvent);
  });
};

await runDispatcher({ initialRuntime: runtime, switchCwd, onSession });

logErr(`dispatcher exited`);
