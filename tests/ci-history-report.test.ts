import assert from "node:assert/strict";
import { test } from "node:test";
import { failingTests, summarizeRuns } from "../scripts/ci-history-report.mjs";

test("history parser deduplicates Bun's repeated failure summary and TAP failures", () => {
  assert.deepEqual(failingTests(`
(fail) search > handles lock [32.1ms]
Test failed:
(fail) search > handles lock [32.1ms]
✖ provider timed out (15.4ms)
✖ failing tests:
  `), ["search > handles lock", "provider timed out"]);
});

test("history aggregates failures by OS and counts signatures once per failing run", () => {
  const failure = {
    summary: { platform: "win32", status: "failed", results: [{ id: "tools-suite", status: "failed" }] },
    logs: { "tools-suite": "(fail) locked database [2ms]\nEBUSY EBUSY\n(fail) locked database [2ms]\nRan 100 tests across 3 files. [24.2s]" },
  };
  const success = {
    summary: { platform: "linux", status: "passed", results: [{ id: "tools-suite", status: "passed" }] },
    logs: {},
  };
  const report = summarizeRuns([failure, failure, success]);
  assert.deepEqual(report.platforms, [
    { platform: "linux", gate: "full", runs: 1, passed: 1, failed: 0, incomplete: 0 },
    { platform: "win32", gate: "full", runs: 2, passed: 0, failed: 2, incomplete: 0 },
  ]);
  assert.deepEqual(report.tests, [{ platform: "win32", gate: "full", name: "locked database", occurrences: 2 }]);
  assert.deepEqual(report.codes, [{ platform: "win32", gate: "full", code: "EBUSY", runs: 2 }]);
  assert.deepEqual(report.bunSuiteSeconds, [{ platform: "win32", samples: 2, median: 24.2, max: 24.2 }]);
});

test("history separates fast preflight runs from the full native gate", () => {
  const run = { summary: {
    platform: "linux", status: "failed",
    results: [{ id: "test-contracts", status: "passed" }, { id: "linux-lsp", status: "failed" }],
  }, logs: { "linux-lsp": "(fail) connect reset [5ms]\nECONNRESET" } };
  const report = summarizeRuns([run]);
  assert.equal(report.platforms[0].gate, "preflight");
  assert.equal(report.tests[0].gate, "preflight");
  assert.equal(report.codes[0].gate, "preflight");
});
