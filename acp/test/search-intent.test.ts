import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DesktopSearchIntentService, parseSearchIntentRequest } from "../src/search/intent.js";
import type { SearchIntentResponse } from "../src/search/contract.js";

const signal = () => new AbortController().signal;
const auth = (key?: string) => ({ key: async (_signal: AbortSignal) => key });
const answer = (choice: unknown, status = 200) =>
  new Response(JSON.stringify({ answers: { intent: { type: "choice", choice } } }), { status });

describe("Desktop universal search Auto / Jev", () => {
  it("accepts only absolute project paths and bounded queries, discarding extra fields", () => {
    assert.deepEqual(parseSearchIntentRequest({ cwd: "/project", query: " why? ", secret: "discard" }),
      { cwd: "/project", query: "why?" });
    for (const invalid of [
      null, [], { cwd: "relative", query: "why" }, { cwd: "/project", query: "" },
      { cwd: "/project", query: " ".repeat(20) }, { cwd: "/project", query: "x".repeat(2049) },
      { cwd: "/project\0bad", query: "why" }, { cwd: "/project", query: "why\0not" },
    ]) assert.throws(() => parseSearchIntentRequest(invalid));
  });

  it("uses only the submitted query in a single Jev Decisions request", async () => {
    let count = 0;
    const service = new DesktopSearchIntentService({
      auth: auth("saved-key"),
      fetch: async (url, init) => {
        count++;
        assert.equal(String(url), "https://openrouter.ai/api/alpha/decisions");
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer saved-key");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.model, "~typesafe/jev-latest");
        assert.deepEqual(body.state, { query: "Почему отказались от Ollama?" });
        assert.ok(!JSON.stringify(body).includes("/project") && !JSON.stringify(body).includes("session-content"));
        const questions = body.questions as { intent: { type: string; criteria: Record<string, string> } };
        assert.equal(questions.intent.type, "choice");
        assert.deepEqual(Object.keys(questions.intent.criteria), ["search", "ask"]);
        return answer("ask");
      },
    });
    const result = await service.classify("Почему отказались от Ollama?", signal());
    assert.deepEqual(result, { intent: "ask", fallback: false });
    assert.equal(count, 1);
  });

  it("routes explicit patch search locally and lookups via Jev without extra models", async () => {
    let count = 0;
    const service = new DesktopSearchIntentService({
      auth: auth("key"),
      fetch: async () => { count++; return answer("search"); },
    });
    assert.deepEqual(await service.classify("patch:AbortController", signal()), { intent: "search", fallback: false });
    assert.equal(count, 0);
    assert.deepEqual(await service.classify("где находится sessionWorker", signal()), { intent: "search", fallback: false });
    assert.equal(count, 1);
  });

  it("missing credentials, provider errors and invalid decisions fail closed to Search", async () => {
    let requests = 0;
    const offline = new DesktopSearchIntentService({
      auth: auth(),
      fetch: async () => { requests++; return answer("ask"); },
    });
    assert.deepEqual(await offline.classify("why", signal()), { intent: "search", fallback: true });
    assert.equal(requests, 0);
    for (const fetch of [
      async () => answer("unexpected"),
      async () => answer(null),
      async () => answer("ask", 503),
      async () => { throw new Error("Bearer private-key provider failure"); },
      async () => new Response("{bad json"),
    ]) {
      const service = new DesktopSearchIntentService({ auth: auth("key"), fetch });
      const result: SearchIntentResponse = await service.classify("why", signal());
      assert.deepEqual(result, { intent: "search", fallback: true });
      assert.doesNotMatch(JSON.stringify(result), /private-key|Bearer/);
    }
  });

  it("a cancelled request cannot return an Ask recommendation", async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(r => { resolve = r; });
    const service = new DesktopSearchIntentService({ auth: auth("key"), fetch: async () => pending });
    const owner = new AbortController();
    const result = service.classify("how does it work?", owner.signal);
    await new Promise(r => setImmediate(r));
    owner.abort();
    resolve(answer("ask"));
    await assert.rejects(result);
  });
  it("cancellation settles even when the provider ignores AbortSignal", async () => {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const service = new DesktopSearchIntentService({
      auth: auth("key"),
      fetch: async () => {
        entered();
        return new Promise<Response>(() => {});
      },
    });
    const owner = new AbortController();
    const result = service.classify("explain architecture", owner.signal);
    await ready;
    owner.abort();
    await assert.rejects(result);
  });
});
