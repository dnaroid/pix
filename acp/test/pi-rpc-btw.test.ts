import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiRpcClient, type PiEvent } from "../src/pi/pi-rpc-client.js";

test("BTW state and cancellation cross the real SDK RPC guard without a parent turn", { timeout: 45_000 }, async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const artifacts = join(root, ".pi/artifacts"); await mkdir(artifacts, { recursive: true });
  const workspace = await mkdtemp(join(artifacts, "btw-rpc-"));
  const client = new PiRpcClient({ piEntry: join(root, "acp/src/pi/pix-rpc-entry.js"), cwd: workspace,
    args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates"],
    env: { HOME: join(workspace, "home"), PI_CONFIG_DIR: join(workspace, "config"), PI_CODING_AGENT_DIR: join(workspace, "agent"),
      PI_AGENT_DIR: join(workspace, "agent"), PI_OFFLINE: "1", NODE_OPTIONS: `--import ${new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href}` } });
  const events: PiEvent[] = []; const remove = client.onEvent((event) => events.push(event));
  try {
    await client.start();
    const [first, second] = await Promise.all([client.btw({ action: "state" }), client.btw({ action: "state" })]);
    assert.deepEqual(first, second); assert.equal(first.busyRequestId, null);
    await client.btw({ action: "cancel", runtimeId: first.runtimeId, requestId: "not-running" });
    await assert.rejects(client.btw({ action: "ask", runtimeId: first.runtimeId, requestId: "q", question: "SIDE_ONLY", history: [], excerpts: [] }), /offline/);
    assert.deepEqual(await client.getMessages(), []);
    assert.equal((await client.getState()).isStreaming, false);
    assert.equal(events.some((event) => ["message_start", "agent_start", "pix_btw_response"].includes(event.type)), false);
  } finally { remove(); await client.stop(); await rm(workspace, { recursive: true, force: true }); }
});
