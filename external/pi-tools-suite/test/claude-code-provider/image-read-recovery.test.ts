import assert from "node:assert/strict";
import { test } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { onlyAttachedImageReads, PRIVATE_TRANSPORT_ERROR, recoverImageRead } from "../../src/claude-code-provider/src/image-read-recovery.ts";

const image = "/private/tmp/pi-claude-code-provider-images-test/image-a.png";
function call(path = image, name = "Read", id = "denied"): ToolCall {
  return { type: "toolCall", id, name, arguments: { file_path: path } };
}
function message(stopReason: AssistantMessage["stopReason"] = "error", content: AssistantMessage["content"] = [call()]): AssistantMessage {
  return { role: "assistant", api: "pi-claude-code-provider-headless" as AssistantMessage["api"],
    provider: "pi-claude-code-provider", model: "opus", timestamp: 1, content, stopReason,
    ...(stopReason === "error" ? { errorMessage: PRIVATE_TRANSPORT_ERROR } : {}),
    usage: { input: 4, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 10,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } } };
}
function publish(source: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage): void {
  source.push({ type: "start", partial: output });
  if (output.content[0]?.type === "toolCall") {
    source.push({ type: "toolcall_start", contentIndex: 0, partial: output });
    source.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(output.content[0].arguments), partial: output });
    source.push({ type: "toolcall_end", contentIndex: 0, toolCall: output.content[0], partial: output });
  }
  if (output.stopReason === "error" || output.stopReason === "aborted") source.push({ type: "error", reason: output.stopReason, error: output });
  else {
    assert.notEqual(output.stopReason, "pending");
    source.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse" | "deferred", message: output });
  }
  source.end();
}

test("recovery classification requires only exact current attachments and minimal Read arguments", () => {
  assert.equal(onlyAttachedImageReads(message(), [image]), true);
  assert.equal(onlyAttachedImageReads(message("error", [{ ...call(), name: "read", arguments: { path: image } }]), [image]), true);
  for (const content of [[], [call(image + "/../request.json")], [call(image, "shell")],
    [call("/private/tmp/older/image-a.png")], [call(), call("README.md")],
    [{ ...call(), arguments: { file_path: image, other: image } }],
    [{ ...call(), arguments: { file_path: { nested: image } } }],
    [{ ...call(), arguments: { command: `cat ${image}` } }],
    [{ ...call(), arguments: { file_path: image, offset: 1 } }],
  ] as AssistantMessage["content"][]) {
    assert.equal(onlyAttachedImageReads(message("error", content), [image]), false, JSON.stringify(content));
  }
  assert.equal(onlyAttachedImageReads(message(), []), false);
});

test("one corrective attempt after full finalization; rejected call never escapes and usage is cumulative", async () => {
  let launches = 0;
  let finalized = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stream = recoverImageRead((attempt) => {
    launches++;
    const source = createAssistantMessageEventStream();
    attempt.onPrepared(true);
    if (launches === 1) {
      assert.equal(attempt.correction, false);
      attempt.onRecoverable();
      const first = message();
      first.usage.reasoning = 1;
      first.usage.cacheWrite1h = 1;
      publish(source, first);
      void gate.then(() => { finalized = true; attempt.onSettled(); });
    } else {
      assert.equal(finalized, true);
      assert.equal(attempt.correction, true);
      const second = message("toolUse", [call("README.md", "read", "safe")]);
      second.usage.reasoning = 2;
      publish(source, second);
      attempt.onSettled();
    }
    return source;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches, 1);
  release();
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(launches, 2);
  assert.equal(result.stopReason, "toolUse");
  assert.deepEqual(result.usage, { input: 8, output: 4, cacheRead: 6, cacheWrite: 2, totalTokens: 20,
    reasoning: 3, cacheWrite1h: 1,
    cost: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 } });
  assert.doesNotMatch(JSON.stringify(events), /denied|image-a\.png/);
  assert.equal(events.filter((event) => event.type === "done").length, 1);
});

test("second invalid proposal terminates with one error and no executable call", async () => {
  let launches = 0;
  const stream = recoverImageRead((attempt) => {
    launches++;
    const source = createAssistantMessageEventStream();
    attempt.onPrepared(true);
    attempt.onRecoverable();
    publish(source, message());
    attempt.onSettled();
    return source;
  });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(launches, 2);
  assert.equal((await stream.result()).stopReason, "error");
  assert.deepEqual((await stream.result()).content, []);
  assert.equal(events.filter((event) => event.type === "error").length, 1);
  assert.equal(events.some((event) => event.type.startsWith("toolcall_")), false);
});

for (const scenario of ["not-eligible", "cleanup-failure", "abort", "timeout"] as const) {
  test(`does not retry ${scenario}`, async () => {
    let launches = 0;
    const controller = new AbortController();
    const stream = recoverImageRead((attempt) => {
      launches++;
      const source = createAssistantMessageEventStream();
      attempt.onPrepared(true);
      if (scenario !== "not-eligible") attempt.onRecoverable();
      const output = message();
      if (scenario === "cleanup-failure") output.errorMessage += "; cleanup failed";
      publish(source, output);
      if (scenario === "abort") controller.abort();
      if (scenario === "timeout") setTimeout(attempt.onSettled, 20);
      else attempt.onSettled();
      return source;
    }, { signal: controller.signal, timeoutMs: scenario === "timeout" ? 1 : 1000 });
    const output = await stream.result();
    assert.equal(launches, 1);
    assert.equal(output.stopReason, "error");
    assert.deepEqual(output.content, []);
  });
}

test("text-only requests retain live streaming before process finalization", async () => {
  let finish!: () => void;
  const stream = recoverImageRead((attempt) => {
    const source = createAssistantMessageEventStream();
    attempt.onPrepared(false);
    const output = message("stop", [{ type: "text", text: "live" }]);
    source.push({ type: "start", partial: output });
    finish = () => { source.push({ type: "done", reason: "stop", message: output }); source.end(); attempt.onSettled(); };
    return source;
  });
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "start");
  finish();
  assert.equal((await stream.result()).stopReason, "stop");
});

test("remaining timeout decreases across attempts, and unexpected launch failure settles", async () => {
  const budgets: number[] = [];
  const stream = recoverImageRead((attempt, options) => {
    budgets.push(options!.timeoutMs!);
    if (budgets.length === 2) throw new Error("broken launch");
    const source = createAssistantMessageEventStream();
    attempt.onPrepared(true);
    attempt.onRecoverable();
    publish(source, message());
    setTimeout(attempt.onSettled, 15);
    return source;
  }, { timeoutMs: 1000 });
  assert.match((await stream.result()).errorMessage!, /broken launch/);
  assert.ok(budgets[1]! < budgets[0]!);
  const immediateFailure = recoverImageRead(() => { throw new Error("first launch"); });
  assert.match((await immediateFailure.result()).errorMessage!, /first launch/);
});
