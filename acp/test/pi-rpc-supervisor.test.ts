import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiRpcClient } from "../src/pi/pi-rpc-client.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Real SDK RPC: the bridge exists only with PIX_SUPERVISOR_BRIDGE=1 and never starts a model turn. */
async function probe(t: { signal: AbortSignal }, bridge: boolean): Promise<{ status: string; events: string[] }> {
  const artifacts = join(root, ".pi/artifacts");
  await mkdir(artifacts, { recursive: true });
  const workspace = await mkdtemp(join(artifacts, "supervisor-rpc-"));
  const extension = join(workspace, "probe.ts");
  await writeFile(extension, `export default function(pi) {
    pi.on("session_start", (_event, ctx) => {
      setImmediate(async () => {
        const host = globalThis[Symbol.for("pix.supervisor.request")];
        if (typeof host !== "function") { ctx.ui.setStatus("supervisor-probe", "ABSENT"); return; }
        try {
          const result = await host({ ownerSessionId: ctx.sessionManager.getSessionId(), op: "status" });
          ctx.ui.setStatus("supervisor-probe", JSON.stringify(result));
        } catch (error) { ctx.ui.setStatus("supervisor-probe", "ERROR: " + error.message); }
      });
    });
  }`);
  const client = new PiRpcClient({ piEntry: join(root, "acp/src/pi/pix-rpc-entry.js"), cwd: workspace,
    args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--extension", extension],
    env: { HOME: join(workspace, "home"), PI_CONFIG_DIR: join(workspace, "config"), PI_CODING_AGENT_DIR: join(workspace, "agent"),
      PI_AGENT_DIR: join(workspace, "agent"), PI_OFFLINE: "1", ...(bridge ? { PIX_SUPERVISOR_BRIDGE: "1" } : {}),
      NODE_OPTIONS: `--import ${new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href}` } });
  const events: string[] = [];
  let resolve!: (text: string) => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  t.signal.addEventListener("abort", () => reject(new Error("supervisor RPC test aborted")), { once: true });
  const remove = client.onEvent((event) => {
    events.push(event.type);
    if (event.type === "pix_supervisor_request") {
      void client.respondToSupervisor(event.requestId, { result: { echoed: event.request } }).catch(reject);
    } else if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "supervisor-probe") {
      resolve(event.statusText ?? "");
    }
  });
  try {
    await client.start();
    const status = await done;
    assert.deepEqual(await client.getMessages(), []);
    return { status, events };
  } finally { remove(); await client.stop(); await rm(workspace, { recursive: true, force: true }); }
}

test("supervisor bridge crosses the real SDK RPC only in the supervisor runtime", { timeout: 90_000 }, async (t) => {
  const enabled = await probe(t, true);
  assert.deepEqual(JSON.parse(enabled.status), { echoed: { op: "status" } });
  assert.equal(enabled.events.some((type) => ["message_start", "agent_start"].includes(type)), false);
  const disabled = await probe(t, false);
  assert.equal(disabled.status, "ABSENT");
  assert.equal(disabled.events.includes("pix_supervisor_request"), false);
});
