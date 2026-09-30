import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { applyClaudeImageReadPatch, patchedProvider } from "../scripts/claude-image-read-patch.mjs";

// Opt in against a pristine/patched upstream checkout; no Claude subscription,
// credentials, UI, network, or actual Pi tool execution is involved.
const directory = process.env.PIX_CLAUDE_PROVIDER_TEST_DIR;
const model = { id: "opus", name: "Opus", api: "pi-claude-code-provider-headless" as Api,
  provider: "pi-claude-code-provider", baseUrl: "pi-claude-code-provider://local", reasoning: true,
  input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000, maxTokens: 64_000 } as Model<Api>;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
const tools = [{ name: "Read", description: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } }];
const messages = [
  { role: "user" as const, content: [{ type: "image" as const, data: png, mimeType: "image/png" }], timestamp: 1 },
  { role: "user" as const, content: "Continue the original task using the historical attachment", timestamp: 2 },
];
const toolContext = normalizeContext({ tools, messages });

const scenarios = ["normal", "recover", "safe-tool", "repeat", "transport", "mixed", "mcp-violation", "cleanup", "bad-exit", "abort", "close", "payload-hook"];
for (const scenario of scenarios) {
  test(`patched real provider subprocess simulation: ${scenario}`, { skip: !directory, timeout: 15000 }, async () => {
    const { createClaudeStream } = await import(pathToFileURL(join(directory!, "src/provider.ts")).href);
    const { SessionImageStore } = await import(pathToFileURL(join(directory!, "src/session-image-store.ts")).href);
    const root = await mkdtemp(join(tmpdir(), "pix-image-read-simulation-"));
    const executable = join(root, "claude");
    const store = new SessionImageStore();
    store.open();
    const controller = new AbortController();
    let resolutions = 0;
    const cleaned: string[] = [];
    await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs"); const path = require("node:path");
const scenario = ${JSON.stringify(scenario)};
const log = path.join(__dirname, "attempts.jsonl");
const previous = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\\n").map(JSON.parse) : [];
const attempt = previous.length;
const privateDir = path.dirname(process.argv[process.argv.indexOf("--system-prompt-file") + 1]);
const system = fs.readFileSync(path.join(privateDir, "system-prompt.txt"), "utf8");
const mcp = JSON.parse(process.argv[process.argv.indexOf("--mcp-config") + 1]).mcpServers.pi.env;
fs.writeFileSync(mcp.PI_CLAUDE_TOOL_READY, "ready\\n", {flag:"wx"});
let prompt = "";
const emit = (value) => fs.writeSync(1, JSON.stringify(value) + "\\n");
process.on("SIGTERM", () => {
  if (scenario === "mcp-violation") fs.writeFileSync(mcp.PI_CLAUDE_TOOL_VIOLATION, "attempt\\n", {flag:"wx"});
  emit({type:"result",subtype:"error_during_execution",is_error:true,stop_reason:"tool_use",terminal_reason:"aborted_streaming",usage:{input_tokens:4,output_tokens:2}});
  process.exit(scenario === "bad-exit" ? 7 : 143);
});
process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => prompt += chunk);
process.stdin.on("end", () => {
  const attachment = /@"([^"\\n]+\\.png)"/.exec(JSON.parse(prompt).message.content.map(block => block.text).join("\\n"))?.[1];
  fs.appendFileSync(log, JSON.stringify({pid:process.pid,privateDir,attachment,correction:system.includes("Provider transport correction:"),
    oldRequestExists:previous.length > 0 && fs.existsSync(previous[0].privateDir),
    imageExists:!!attachment && fs.existsSync(attachment),cwd:process.cwd()}) + "\\n");
  emit({type:"system",subtype:"init",tools:["mcp__pi__Read"],mcp_servers:[{name:"pi",status:"connected"}],model:"claude-opus-5-5",permissionMode:"dontAsk",slash_commands:[],skills:[],plugins:[],apiKeySource:"none"});
  emit({type:"stream_event",event:{type:"message_start",message:{id:"msg_"+attempt,model:"claude-opus-5-5",usage:{}}}});
  if (scenario === "normal" || (attempt > 0 && !["repeat","safe-tool"].includes(scenario))) {
    emit({type:"result",is_error:false,result:"continued using attachments",usage:{input_tokens:4,output_tokens:2}});
    return;
  }
  const target = attempt > 0 && scenario === "safe-tool" ? "README.md" : scenario === "transport" ? path.join(privateDir,"request.json") : attachment;
  const targets = scenario === "mixed" ? [target, "README.md"] : [target];
  targets.forEach((file_path, index) => {
    emit({type:"stream_event",event:{type:"content_block_start",index,content_block:{type:"tool_use",id:(file_path === "README.md" ? "safe_" : "denied_")+attempt+index,name:"mcp__pi__Read",input:{}}}});
    emit({type:"stream_event",event:{type:"content_block_delta",index,delta:{type:"input_json_delta",partial_json:JSON.stringify({file_path})}}});
    emit({type:"stream_event",event:{type:"content_block_stop",index}});
  });
  emit({type:"stream_event",event:{type:"message_delta",delta:{stop_reason:"tool_use"}}});
  setInterval(() => {}, 1000);
});
`);
    await chmod(executable, 0o700);
    try {
      const stream = createClaudeStream({ executable, version: "2.1.281", subscriptionType: "pro" }, {
        resolveSession: () => { resolutions++; return { cwd: root, imageStore: store }; },
        cleanupDirectory: async (privateDir: string) => {
          cleaned.push(privateDir);
          if (scenario === "cleanup") throw new Error("synthetic private cleanup failure");
          if (scenario === "abort") controller.abort();
          if (scenario === "close") await store.close();
          await rm(privateDir, { recursive: true, force: true });
        },
      })(model, scenario === "payload-hook" ? normalizeContext({ tools, messages: [] }) : toolContext,
        { signal: controller.signal, timeoutMs: 5000,
          ...(scenario === "payload-hook" ? { onPayload: () => ({ systemPrompt: "hook replacement", tools, messages }) } : {}) });
      const events = [];
      for await (const event of stream) events.push(event);
      const result = await stream.result();
      const attempts = (await readFile(join(root, "attempts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const recovered = ["recover", "safe-tool", "repeat", "payload-hook"].includes(scenario);
      assert.equal(attempts.length, recovered ? 2 : 1, result.errorMessage ?? JSON.stringify(result));
      assert.equal(resolutions, 1, "retry must not resolve a different Pi session");
      assert.equal(result.stopReason, scenario === "safe-tool" ? "toolUse" : ["normal", "recover", "payload-hook"].includes(scenario) ? "stop" : scenario === "abort" ? "aborted" : "error", result.errorMessage ?? JSON.stringify(result));
      assert.doesNotMatch(JSON.stringify(events), /denied_/);
      assert.doesNotMatch(JSON.stringify(result.content), /pi-claude-code-provider-(images|request)/);
      assert.equal(events.filter((event: { type: string }) => event.type === "done" || event.type === "error").length, 1);
      if (recovered) {
        assert.equal(attempts[1].correction, true);
        assert.equal(attempts[1].oldRequestExists, false);
        assert.equal(attempts[1].imageExists, true);
        assert.equal(attempts[1].attachment, attempts[0].attachment, "session image path remains stable across retry");
        assert.equal(result.usage.totalTokens, 12, "both subprocess usages are counted");
      }
      if (scenario === "safe-tool") assert.equal(result.content[0]?.arguments.file_path, "README.md");
      if (scenario === "cleanup") assert.match(result.errorMessage, /synthetic private cleanup failure/);
      if (scenario === "mcp-violation") assert.match(result.errorMessage, /Security invariant violated/);
      if (scenario === "close") assert.match(result.errorMessage, /image store is unavailable/);
      for (const attempt of attempts) assert.throws(() => process.kill(attempt.pid, 0), /ESRCH/, "old subprocess must be dead");
    } finally {
      await store.close();
      await Promise.all([...cleaned, root].map((path) => rm(path, { recursive: true, force: true })));
    }
  });
}

test("patch installer is idempotent, exact-version/source gated and preserves unrelated modifications", { skip: !directory }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-provider-patch-installer-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "src"));
    const baseline = await readFile(join(directory!, "src/.pix-original-provider.ts"), "utf8");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-claude-code-provider", version: "0.5.0" }));
    await writeFile(join(root, "src/provider.ts"), baseline);
    assert.equal(await applyClaudeImageReadPatch(root), "installed");
    assert.equal(await applyClaudeImageReadPatch(root), "installed");
    assert.equal(await applyClaudeImageReadPatch(root, { check: true }), "current");
    assert.equal(await readFile(join(root, "src/provider.ts"), "utf8"), patchedProvider(baseline));
    await writeFile(join(root, "src/image-read-recovery.ts"), "// unrelated module change");
    await assert.rejects(applyClaudeImageReadPatch(root), /unrelated modifications/);
    await rm(join(root, "src/image-read-recovery.ts"));
    assert.equal(await applyClaudeImageReadPatch(root), "installed", "recover interrupted module installation");
    await writeFile(join(root, "src/.pix-image-read-patch.lock"), "synthetic owner");
    await assert.rejects(applyClaudeImageReadPatch(root), /already locked/);
    await rm(join(root, "src/.pix-image-read-patch.lock"));
    await writeFile(join(root, "src/provider.ts"), "// unrelated local change\n" + patchedProvider(baseline));
    await assert.rejects(applyClaudeImageReadPatch(root), /unrelated modifications/);
    await rm(join(root, "src/.pix-original-provider.ts"));
    await assert.rejects(applyClaudeImageReadPatch(root), /no original backup/);
    assert.throws(() => patchedProvider(baseline + "\n"), /Unsupported provider/);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-claude-code-provider", version: "0.6.0" }));
    await assert.rejects(applyClaudeImageReadPatch(root), /Expected.*0.5.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
