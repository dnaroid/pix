import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskRunBridge, installTaskRunHost, handleTaskRunResponse } from "../src/pi/task-run-host.js";
import { forwardTaskRun } from "../src/acp/task-run-bridge.js";
import { TASK_RUN_METHOD, TASK_RUN_RESPONSE_PREFIX, parseTaskRunRequest, parseTaskRunResult, type TaskRunRequest } from "../src/acp/task-run-contract.js";
import type { Logger } from "../src/logging.js";
import { PixAcpAgent } from "../src/acp/pix-acp-agent.js";

const receipt = { sessionId: "child", outcome: "started" as const };
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
function fixture() {
  const events: any[] = [];
  const session = { sessionManager: { getSessionId: () => "owner" } };
  const bridge = createTaskRunBridge(session, (event: unknown) => events.push(event));
  return { events, bridge };
}

test("task bridge correlates responses and keeps concurrent launch receipts separate", async () => {
  const { events, bridge } = fixture();
  const a = bridge.launch({ sessionId: "owner", taskId: "a" });
  const b = bridge.launch({ sessionId: "owner", taskId: "b" });
  bridge.respond({ requestId: "foreign", result: receipt });
  bridge.respond({ requestId: events[1].requestId, result: { ...receipt, sessionId: "second" } });
  bridge.respond({ requestId: events[0].requestId, result: receipt });
  assert.deepEqual(await a, receipt);
  assert.deepEqual(await b, { ...receipt, sessionId: "second" });
  bridge.dispose();
  assert.equal(events.length, 2);
});

test("cancellation and teardown retire pending listeners, ignore late replies, and reject stale owners", async () => {
  const { events, bridge } = fixture();
  assert.throws(() => bridge.launch({ sessionId: "stale", taskId: "a" }), /replaced/);
  const controller = new AbortController();
  const aborted = bridge.launch({ sessionId: "owner", taskId: "a" }, controller.signal);
  const rejected = assert.rejects(aborted, /inspect the task/);
  controller.abort();
  await rejected;
  assert.equal(events[1].type, "pix_task_run_cancel");
  bridge.respond({ requestId: events[0].requestId, result: receipt });
  const closed = bridge.launch({ sessionId: "owner", taskId: "b" });
  const retired = assert.rejects(closed, /runtime closed/);
  bridge.dispose();
  await retired;
  assert.equal(events.length, 4);
  controller.abort();
  assert.equal(events.length, 4);
  assert.throws(() => bridge.launch({ sessionId: "owner", taskId: "c" }), /replaced/);
});

test("malformed receipts and Desktop failures are errors, never successful starts", async () => {
  const { events, bridge } = fixture();
  const first = bridge.launch({ sessionId: "owner", taskId: "a" });
  const invalid = assert.rejects(first, /Invalid task launch receipt/);
  bridge.respond({ requestId: events[0].requestId, result: { sessionId: "child" } });
  await invalid;
  const second = bridge.launch({ sessionId: "owner", taskId: "b" });
  const failed = assert.rejects(second, /Unknown task/);
  bridge.respond({ requestId: events[1].requestId, error: "Unknown task" });
  await failed;
  bridge.dispose();
});

test("a launch timeout cancels preparation and cannot be revived by a late receipt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: any[] = [];
  const bridge = createTaskRunBridge({ sessionManager: { getSessionId: () => "owner" } },
    (event: unknown) => events.push(event), 50);
  const launched = bridge.launch({ sessionId: "owner", taskId: "a" });
  const rejected = assert.rejects(launched, /inspect the task/);
  t.mock.timers.tick(50);
  await rejected;
  assert.equal(events[1].type, "pix_task_run_cancel");
  bridge.respond({ requestId: events[0].requestId, result: receipt });
  bridge.dispose();
  assert.equal(events.length, 2);
});

test("runtime rebind and dispose revoke the global capability; control replies never prompt", async () => {
  const key = Symbol.for("pix.project-tasks.run");
  const previous = (globalThis as any)[key];
  const events: any[] = [];
  class Session {
    sessionManager = { getSessionId: () => "owner" };
    bindExtensions(_bindings: unknown) {}
    dispose() {}
    _emit(event: unknown) { events.push(event); }
  }
  installTaskRunHost(Session);
  const session = new Session();
  try {
    session.bindExtensions({});
    const pending = (globalThis as any)[key]({ sessionId: "owner", taskId: "a" });
    const rejected = assert.rejects(pending, /runtime closed/);
    session.bindExtensions({});
    await rejected;
    const next = (globalThis as any)[key]({ sessionId: "owner", taskId: "b" });
    let handled = false;
    assert.equal(handleTaskRunResponse(session, TASK_RUN_RESPONSE_PREFIX + JSON.stringify({ requestId: events[2].requestId, result: receipt }), {
      preflightResult: () => { handled = true; },
    }), true);
    assert.deepEqual(await next, receipt);
    assert.equal(handled, true);
    assert.equal(handleTaskRunResponse(session, "ordinary prompt"), false);
    session.dispose();
    assert.equal((globalThis as any)[key], undefined);
  } finally { session.dispose(); if (previous) (globalThis as any)[key] = previous; }
});

test("ACP uses the host's cwd and source owner, sends a validated receipt, and drops stale replies", async () => {
  const requests: TaskRunRequest[] = [];
  const responses: unknown[] = [];
  let current = true;
  const session = {
    acpSessionId: "source", cwd: "/workspace",
    client: { request: async (method: string, request: TaskRunRequest) => {
      assert.equal(method, TASK_RUN_METHOD); requests.push(request); return receipt;
    } },
    pi: { respondToTaskRun: async (...args: unknown[]) => { responses.push(args); } },
  };
  await forwardTaskRun(session, { requestId: "r", taskId: "a" }, () => current, logger);
  assert.deepEqual(requests, [{ requestId: "r", taskId: "a", cwd: "/workspace", sourceSessionId: "source" }]);
  assert.deepEqual(responses, [["r", { result: receipt }]]);
  session.client.request = async () => { current = false; return receipt; };
  await forwardTaskRun(session, { requestId: "r2", taskId: "a" }, () => current, logger);
  assert.equal(responses.length, 1);
});

test("ACP reports launch failures and rejects malformed protocol values", async () => {
  const responses: any[] = [];
  await forwardTaskRun({ acpSessionId: "source", cwd: "/workspace",
    client: { request: async () => { throw new Error("busy"); } },
    pi: { respondToTaskRun: async (_id, response) => { responses.push(response); } },
  }, { requestId: "r", taskId: "a" }, () => true, logger);
  assert.match(responses[0].error, /busy.*inspect the task/);
  assert.throws(() => parseTaskRunRequest({ taskId: "a" }), /Invalid/);
  assert.throws(() => parseTaskRunResult({ sessionId: "", outcome: "started" }), /Invalid/);
});

test("a retiring ACP runtime can cancel its owned request after session replacement", async () => {
  const notifications: unknown[] = [];
  const stale = { acpSessionId: "source", client: { notify: async (...args: unknown[]) => { notifications.push(args); } } };
  const owner = { sessions: new Map([["source", {}]]), options: { logger } };
  const onPiEvent = (PixAcpAgent.prototype as any).onPiEvent;
  onPiEvent.call(owner, stale, { type: "pix_task_run_request", requestId: "old", taskId: "a" });
  assert.deepEqual(notifications, []);
  onPiEvent.call(owner, stale, { type: "pix_task_run_cancel", requestId: "old" });
  await Promise.resolve();
  assert.deepEqual(notifications, [["pix/tasks/run_cancel", { requestId: "old" }]]);
});
