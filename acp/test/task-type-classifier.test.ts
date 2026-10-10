import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DesktopTaskTypeClassifier, parseTaskTypeClassifyRequest } from "../src/tasks/type-classifier.js";
import { CLASSIFIABLE_TASK_TYPES, QUICK_TASK_MAX_LENGTH } from "../src/tasks/type-classification-contract.js";

const signal = () => new AbortController().signal;
const auth = (key?: string) => ({ key: async (_signal: AbortSignal) => key });
const answer = (choice: unknown, status = 200) =>
  new Response(JSON.stringify({ answers: { task_type: { type: "choice", choice } } }), { status });

describe("Desktop Quick Add Jev task type", () => {
  it("accepts only absolute paths and bounded non-empty text, discarding extra fields", () => {
    assert.deepEqual(parseTaskTypeClassifyRequest({ cwd: "/project", text: " Fix a crash ", apiKey: "secret" }),
      { cwd: "/project", text: "Fix a crash" });
    for (const value of [null, [], {}, { cwd: "relative", text: "hello" },
      { cwd: "/project", text: "" }, { cwd: "/project", text: " " },
      { cwd: "/project", text: "x".repeat(QUICK_TASK_MAX_LENGTH + 1) },
      { cwd: "/project\0malicious", text: "hello" }, { cwd: "/project", text: "hello\0world" },
    ]) assert.throws(() => parseTaskTypeClassifyRequest(value));
  });

  it("uses existing shared OpenRouter Jev transport, sending task text only and fixed choices", async () => {
    let requests = 0;
    const classifier = new DesktopTaskTypeClassifier({
      auth: auth("saved-test-key"),
      fetch: async (url, init) => {
        requests++;
        assert.equal(String(url), "https://openrouter.ai/api/alpha/decisions");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer saved-test-key");
        const body = JSON.parse(String(init?.body)) as { model: string; state: unknown;
          questions: { task_type: { type: string; criteria: Record<string, string>; instructions: string } } };
        assert.equal(body.model, "~typesafe/jev-latest");
        assert.deepEqual(body.state, { text: "Исправить падение приложения" });
        assert.deepEqual(Object.keys(body.questions.task_type.criteria), [...CLASSIFIABLE_TASK_TYPES]);
        assert.equal(body.questions.task_type.type, "choice");
        assert.ok(body.questions.task_type.instructions.includes("Do not rewrite"));
        assert.doesNotMatch(JSON.stringify(body), /\/project|secret transcript|saved-test-key/);
        return answer("bug");
      },
    });
    assert.deepEqual(await classifier.classify("Исправить падение приложения", signal()), { type: "bug", fallback: false });
    assert.equal(requests, 1);
  });

  it("fails to the existing Feature type with no key, invalid answers and provider errors", async () => {
    const fallback = { type: "feature", fallback: true };
    const noKey = new DesktopTaskTypeClassifier({ auth: auth(), fetch: async () => { throw new Error("must not call provider"); } });
    assert.deepEqual(await noKey.classify("add a view", signal()), fallback);
    for (const fetch of [
      async () => answer("unknown"),
      async () => answer(null),
      async () => answer("bug", 502),
      async () => new Response("invalid json"),
      async () => { throw new Error("Bearer private-key"); },
    ]) {
      const classifier = new DesktopTaskTypeClassifier({ auth: auth("test"), fetch });
      const result = await classifier.classify("new feature", signal());
      assert.deepEqual(result, fallback);
      assert.doesNotMatch(JSON.stringify(result), /Bearer|private-key/);
    }
  });

  it("cancels promptly even when the provider ignores AbortSignal", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const classifier = new DesktopTaskTypeClassifier({
      auth: auth("test"),
      fetch: async () => { started(); return new Promise<Response>(() => {}); },
    });
    const controller = new AbortController();
    const result = classifier.classify("fix a bug", controller.signal);
    await ready;
    controller.abort();
    await assert.rejects(result);
  });
});
