import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { PixAcpAgent } from "../src/acp/pix-acp-agent.js";
import { KNOWLEDGE_CHECK_METHOD, type KnowledgeCheckRequest, type KnowledgeCheckResult } from "../src/knowledge/contract.js";

test("Desktop Wiki check RPC validates requests, preserves errors and never starts a conversation", async t => {
  const artifacts = fileURLToPath(new URL("../../.pi/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const cwd = await realpath(await mkdtemp(join(artifacts, "knowledge-rpc-")));
  const received: KnowledgeCheckRequest[] = [];
  const warnings: string[] = [];
  let fail = false;
  const source = { path: "wiki/deployment.md", quote: "This deployment follows a different rule.", startLine: 8, endLine: 8 };
  const response: KnowledgeCheckResult = { status: "incomplete", path: "wiki/rules.md", documentHash: "a".repeat(64),
    modelRef: "test/model", checkedSources: 1, conflicts: [], notices: [], reviewedSources: [source],
    uncertainties: [{ draft: { path: "wiki/rules.md", quote: "A current rule", startLine: 1, endLine: 1 },
      existing: source, explanation: "The deployment identity is unspecified." }] };
  const agent = new PixAcpAgent({
    piEntry: "/test/unused.js", sessionMapPath: join(cwd, "sessions.json"), agentDir: join(cwd, "agent"),
    logger: { debug() {}, info() {}, warn(message) { warnings.push(message); }, error() {} },
    createPiClient: () => { throw new Error("Wiki checks must not start a Pi session"); },
    listPiSessions: async () => [], loadTuiTabs: async () => ({ sessionPaths: [] }), loadDefaultModel: () => undefined,
    knowledgeCheckService: { check: async (request, signal) => {
      assert.ok(signal instanceof AbortSignal);
      received.push(request);
      if (fail) throw new Error("Comparison provider is unavailable");
      return response;
    } },
  });
  t.after(async () => { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); });
  const request = { cwd, path: response.path, content: "A current rule", expectedContent: "Previous rule" };
  await client({ name: "pix-desktop" }).connectWith(agent.acpApp, async cx => {
    await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "pix-desktop", version: "test" } });
    assert.deepEqual(await cx.request(KNOWLEDGE_CHECK_METHOD, request), response);
    for (const invalid of [{ ...request, cwd: "relative" }, { ...request, path: "../outside.md" },
      { ...request, content: "x".repeat(48_001) }]) await assert.rejects(cx.request(KNOWLEDGE_CHECK_METHOD, invalid));
    assert.deepEqual(received, [request]);
    fail = true;
    await assert.rejects(cx.request(KNOWLEDGE_CHECK_METHOD, request), /Comparison provider is unavailable/);
  });
  await client({ name: "another-editor" }).connectWith(agent.acpApp, async cx => {
    await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "another-editor", version: "test" } });
    await assert.rejects(cx.request(KNOWLEDGE_CHECK_METHOD, request), /Desktop/);
  });
  assert.equal(received.length, 2);
  assert.equal(agent.sessionCount, 0);
});
