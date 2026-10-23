import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiRpcClient } from "../src/pi/pi-rpc-client.js";

test("saved task launch request and receipt cross the real SDK RPC without a model turn", { timeout: 45_000 }, async (t) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const artifacts = join(root, ".pi/artifacts");
  await mkdir(artifacts, { recursive: true });
  const workspace = await mkdtemp(join(artifacts, "task-run-rpc-"));
  const extension = join(workspace, "launch.ts");
  await writeFile(extension, `export default function(pi) {
    pi.on("session_start", (_event, ctx) => {
      setImmediate(async () => {
        try {
          const launch = globalThis[Symbol.for("pix.project-tasks.run")];
          const result = await launch({ taskId: "saved-task", sessionId: ctx.sessionManager.getSessionId() });
          ctx.ui.setStatus("launch-receipt", JSON.stringify(result));
        } catch (error) { ctx.ui.setStatus("launch-receipt", "ERROR: " + error.message); }
      });
    });
  }`);
  const client = new PiRpcClient({ piEntry: join(root, "acp/src/pi/pix-rpc-entry.js"), cwd: workspace,
    args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--extension", extension],
    env: { HOME: join(workspace, "home"), PI_CONFIG_DIR: join(workspace, "config"), PI_CODING_AGENT_DIR: join(workspace, "agent"),
      PI_AGENT_DIR: join(workspace, "agent"), PI_OFFLINE: "1", NODE_OPTIONS: `--import ${new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href}` } });
  const receipt = { sessionId: "child", outcome: "started" as const };
  const events: string[] = [];
  let resolve!: (text: string) => void;
  let reject!: (error: unknown) => void;
  const completed = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  t.signal.addEventListener("abort", () => reject(new Error("RPC task launch test aborted")), { once: true });
  const remove = client.onEvent((event) => {
    events.push(event.type);
    if (event.type === "pix_task_run_request") {
      if (event.taskId !== "saved-task") { reject(new Error("wrong task id")); return; }
      void client.respondToTaskRun(event.requestId, { result: receipt }).catch(reject);
    } else if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "launch-receipt") {
      resolve(event.statusText ?? "");
    }
  });
  try {
    await client.start();
    assert.deepEqual(JSON.parse(await completed), receipt);
    assert.deepEqual(await client.getMessages(), []);
    assert.equal((await client.getState()).isStreaming, false);
    assert.equal(events.some((type) => ["message_start", "agent_start"].includes(type)), false);
  } finally { remove(); await client.stop(); await rm(workspace, { recursive: true, force: true }); }
});
