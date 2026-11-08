import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, isRetryableAssistantError, normalizeContext } from "@earendil-works/pi-ai";
import { parseApiRetryNotice } from "../../../../src/claude-code-provider/src/api-retry.ts";
import { getLastRequestMetrics } from "../../../../src/claude-code-provider/src/metrics.ts";
import { createOutput } from "../../../../src/claude-code-provider/src/output.ts";
import { createClaudeStream } from "../../../../src/claude-code-provider/src/provider.ts";
import { superviseProcess } from "../../../../src/claude-code-provider/src/process-utils.ts";
import { ClaudeEventMapper } from "../../../../src/claude-code-provider/src/stream-events.ts";
import { PROVIDER_INIT_FIELDS, initRecord } from "../support/claude-fixture.js";
import { nodeFixtureSource } from "../support/node-fixture.js";

const model = {
    id: "sonnet", name: "Sonnet", api: "pi-claude-code-provider-headless", provider: "pi-claude-code-provider",
    baseUrl: "pi-claude-code-provider://local", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 64_000,
};
const init = initRecord(PROVIDER_INIT_FIELDS);
const retry = { type: "system", subtype: "api_retry", error: "overloaded", error_status: 529, attempt: 1, retry_delay_ms: 527 };
const messageStart = { type: "stream_event", event: { type: "message_start", message: { id: "msg_retry", model: "claude-sonnet-5", usage: {} } } };

test("retry observations sanitize untrusted strings and malformed optional fields", () => {
    assert.deepEqual(parseApiRetryNotice(retry), { category: "overloaded", httpStatus: 529, attempt: 1, retryDelayMs: 527 });
    assert.deepEqual(parseApiRetryNotice({}), { category: "unknown" });
    for (const invalid of [null, "123", -1, 0.5, Infinity, NaN, 2_147_483_648]) {
        assert.deepEqual(parseApiRetryNotice({ error: "/private/secret", error_status: invalid, attempt: invalid, retry_delay_ms: invalid }), { category: "other" });
    }
    assert.deepEqual(parseApiRetryNotice({ error: "unknown", error_status: 600, attempt: 0, retry_delay_ms: 0 }), { category: "unknown", attempt: 0, retryDelayMs: 0 });
});

test("mapper observes only retries between validated init and message_start", () => {
    const notices = [];
    const output = createOutput(model);
    const mapper = new ClaudeEventMapper({
        stream: createAssistantMessageEventStream(), output, expectedTools: new Set(), toolNames: new Map(),
        onToolUse() {}, onPreStreamRetry: (notice) => notices.push(notice),
    });
    assert.throws(() => mapper.accept(retry), /before initialization/);
    assert.equal(notices.length, 0);
    mapper.accept(init);
    mapper.accept(retry);
    mapper.accept({ ...retry, error: "unknown", error_status: null, attempt: 2 });
    assert.equal(notices.length, 2);
    assert.equal(notices[1].category, "unknown");
    assert.equal(notices[1].httpStatus, undefined);
    assert.deepEqual(output.content, []);
    mapper.accept(messageStart);
    assert.throws(() => mapper.accept(retry), (error) => {
        assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: error.message }), true);
        return true;
    });
    assert.equal(notices.length, 2);
});

// One sink installed for this process, because the suite's optional sink is cached.
const sinkSymbol = Symbol.for("pix.diagnostics.sink");
const hostSymbol = Symbol.for("pix.host.runtime");
const oldSink = globalThis[sinkSymbol];
const oldHost = globalThis[hostSymbol];
let records = [];
test.before(() => {
    globalThis[hostSymbol] = true;
    globalThis[sinkSymbol] = (...record) => { records.push(record); };
});
test.after(() => {
    if (oldSink === undefined) delete globalThis[sinkSymbol]; else globalThis[sinkSymbol] = oldSink;
    if (oldHost === undefined) delete globalThis[hostSymbol]; else globalThis[hostSymbol] = oldHost;
});

async function fakeClaude(body) {
    const directory = await mkdtemp(join(tmpdir(), "claude-retry-observation-"));
    const executable = join(directory, process.platform === "win32" ? "claude.cjs" : "claude");
    try {
        await writeFile(executable, nodeFixtureSource(`
process.stdin.resume();
const emit = record => process.stdout.write(JSON.stringify(record) + "\\n");
emit(${JSON.stringify(init)});
${body}
`));
        await chmod(executable, 0o700);
        return { directory, executable };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

async function settledMetrics(requestedModel) {
    // The terminal event precedes cleanup and metrics publication. Session-specific
    // cwd provenance is not needed here; a unique requested model name correlates it.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const metrics = getLastRequestMetrics();
        if (metrics?.requestedModel === requestedModel) return metrics;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("retry observation metrics did not settle");
}

for (const outcome of ["success", "error", "abort"]) {
    test(`provider retains pre-stream retry metrics on ${outcome}, without changing timeout activity`, { timeout: 15_000 }, async () => {
        let final = "setInterval(() => {}, 1000);";
        if (outcome === "success") final = `
emit(${JSON.stringify(messageStart)});
emit({ type: "result", is_error: false, result: "ok", usage: { input_tokens: 4, output_tokens: 2 } });
process.exit(0);`;
        else if (outcome === "error") final = `
emit(${JSON.stringify(messageStart)});
emit(${JSON.stringify(retry)});
setInterval(() => {}, 1000);`;
        const fake = await fakeClaude(`
emit(${JSON.stringify(retry)});
emit(${JSON.stringify({ ...retry, error: "unknown", error_status: null, attempt: 2 })});
${final}`);
        const controller = new AbortController();
        const requestId = `retry-${outcome}`;
        let touches = 0;
        let budgets;
        records = [];
        try {
            const stream = createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" }, {
                resolveSession: () => ({ cwd: tmpdir() }),
                supervise(child, options) {
                    budgets = { idle: options.idleTimeoutMs, total: options.totalTimeoutMs };
                    const supervisor = superviseProcess(child, options);
                    return { ...supervisor, touch() {
                        touches++;
                        supervisor.touch();
                        // The microtask runs after accept() records the second retry,
                        // at a deterministic protocol barrier rather than a sleep.
                        if (outcome === "abort" && touches === 3) queueMicrotask(() => controller.abort());
                    } };
                },
            })({ ...model, id: requestId }, normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }), {
                sessionId: requestId, signal: controller.signal, timeoutMs: 10_000,
            });
            const result = await stream.result();
            const metrics = await settledMetrics(requestId);
            assert.equal(result.stopReason, outcome === "success" ? "stop" : outcome === "abort" ? "aborted" : "error");
            assert.equal(metrics.cleanupComplete, true);
            assert.equal(metrics.preStreamRetries.count, 2);
            assert.deepEqual(metrics.preStreamRetries.last, { category: "unknown", attempt: 2, retryDelayMs: 527 });
            assert.equal(records.length, 1);
            const [level, event, details, scope] = records[0];
            assert.equal(level, "warn");
            assert.equal(event, "suite:pre-stream-retry");
            assert.deepEqual(details, { count: 1, retryCategory: "overloaded", httpStatus: 529, attempt: 1, retryDelayMs: 527 });
            assert.equal(scope.sessionId, requestId);
            assert.equal(scope.project, tmpdir());
            assert.equal(budgets.idle, metrics.timeouts.effectiveIdleMs);
            assert.equal(budgets.total, metrics.timeouts.effectiveTotalMs);
            assert.equal(budgets.idle, budgets.total);
            // Every accepted record still resets protocol idle, including each retry.
            assert.equal(touches, outcome === "abort" ? 3 : 5);
            if (outcome === "error") assert.equal(isRetryableAssistantError(result), true);
            metrics.preStreamRetries.last.category = "other";
            assert.equal(getLastRequestMetrics().preStreamRetries.last.category, "unknown");
        } finally {
            controller.abort();
            await rm(fake.directory, { recursive: true, force: true });
        }
    });
}
