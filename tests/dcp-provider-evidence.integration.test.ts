import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant, runtime, user } from "./helpers/dcp-runtime.js";
import { collectProviderToolResultEvidence, providerPayloadIncludesToolResult } from "../external/pi-tools-suite/src/dcp/provider-tool-results.js";

// Exercise the installed SDK serializer rather than duplicating its wire shape.
const converterUrl = new URL("../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js", import.meta.url);
const { convertResponsesMessages } = await import(converterUrl.href);
const model = { provider: "openai-codex", id: "fixture", api: "openai-codex-responses", input: ["text"], contextWindow: 272_000, maxTokens: 128_000 };
const serialize = (messages: any[]) => ({ input: convertResponsesMessages(model, { messages }, new Set([model.provider]), {
  grammarToolInputProperties: new Map([["codemode", "code"]]),
}) });

test("Responses evidence accepts output items, not assistant calls or lookalike IDs", () => {
  const record = { toolCallId: "call_1|ctc_1", toolName: "codemode" } as any;
  for (const type of ["function_call_output", "custom_tool_call_output"]) {
    assert.equal(providerPayloadIncludesToolResult(collectProviderToolResultEvidence({ input: [
      { type, call_id: "call_1", output: "result" },
    ] }), record), true, type);
  }
  for (const item of [
    { type: "custom_tool_call", call_id: "call_1", input: "return 1" },
    { type: "function_call", call_id: "call_1", arguments: "{}" },
    { type: "custom_tool_call_output", call_id: "call", output: "wrong call" },
  ]) {
    assert.equal(providerPayloadIncludesToolResult(collectProviderToolResultEvidence({ input: [item] }), record), false);
  }
});

test("completed grammar-tool output enables DCP capacity recovery in one long turn", async () => {
  const manager = SessionManager.inMemory(process.cwd());
  const f = await runtime(manager);
  f.ctx.model = model;
  let usage = 100_000;
  f.ctx.getContextUsage = () => ({ tokens: usage, contextWindow: model.contextWindow });
  await f.emit("session_start", { reason: "new" });
  manager.appendMessage(user("ACTIVE_REQUEST: inspect the code and preserve recent results", 1));
  await f.project();
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const id = `call_${i}|ctc_${i}`;
    ids.push(id);
    const content = [{ type: "text" as const, text: `Result ${i}: completed inspection.\n${"old details ".repeat(500)}` }];
    const args = { code: `return ${i}` };
    await f.emit("tool_call", { toolCallId: id, toolName: "codemode", input: args });
    await f.emit("tool_result", { toolCallId: id, toolName: "codemode", content, details: {}, isError: false });
    manager.appendMessage({ ...assistant("", i * 2 + 2), provider: model.provider, model: model.id, api: model.api,
      stopReason: "toolUse", content: [{ type: "toolCall", id, name: "codemode", arguments: args }] });
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "codemode", content, isError: false, timestamp: i * 2 + 3 });
  }
  const projection = await f.project();
  const payload = serialize(projection.messages);
  assert.equal(payload.input.filter((item: any) => item.type === "custom_tool_call_output").length, 30);
  const complete = (stopReason: string) => f.emit("message_end", { message: {
    ...assistant("Continue", 100), provider: model.provider, model: model.id, stopReason,
  } });
  for (const failure of ["error", "aborted"]) {
    await f.emit("before_provider_request", { payload });
    await f.emit("after_provider_response", { status: 200 });
    assert.equal(f.state.providerSeenToolIds.size, 0, "HTTP acceptance alone is not evidence");
    await complete(failure);
    assert.equal(f.state.providerSeenToolIds.size, 0, "failed streams stay protected");
  }
  await f.emit("before_provider_request", { payload });
  await complete("toolUse");
  assert.equal(f.state.providerSeenToolIds.size, 30);

  // Same capacity numbers as the incident; recovery must prune only eligible
  // completed output, not abort or erase the active task/newest pairs.
  usage = 144_294;
  const recovered = await f.project();
  assert.ok(f.state.prunedToolIds.size > 0);
  assert.ok(JSON.stringify(recovered.messages).includes("ACTIVE_REQUEST"));
  for (const id of ids.slice(-8)) assert.equal(f.state.prunedToolIds.has(id), false);
  await f.send(recovered);
  const requests = manager.getBranch().filter((entry: any) => entry.customType === "dcp-diagnostic" && entry.data.event === "request");
  const snapshot = (requests[requests.length - 1] as any).data.snapshot;
  assert.ok(snapshot.projectedTokens <= snapshot.inputCapacityTokens);
});
