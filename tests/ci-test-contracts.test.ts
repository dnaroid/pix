import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addedHazards, detectTestContractHazards, findingsToBaseline,
} from "../scripts/ci-test-contracts.mjs";

test("CI contracts detect fragile elapsed-time success assertions, but not bounded polling", () => {
  const filename = "tests/probe.test.ts";
  const code = `
    await new Promise(resolve => setTimeout(resolve, 100));
    await eventually(() => processExited(child));
    expect(Date.now() - started).toBeLessThan(2500);
  `;
  const findings = detectTestContractHazards(filename, code);
  assert.deepEqual(findings.map(f => f.rule), ["elapsed-time-assertion"]);
  assert.equal(findings[0].line, 4);
});

test("CI contracts detect portable-path and SQLite cleanup regressions", () => {
  const code = `
    import { Database } from "bun:sqlite";
    afterEach(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 50 });
    });
    const candidate = filenames.find(p => p.endsWith("/999.jsonl"));
  `;
  const findings = detectTestContractHazards("external/pi-tools-suite/test/example.test.ts", code);
  assert.deepEqual(findings.map(f => f.rule).sort(), [
    "os-specific-path-suffix", "sqlite-direct-fixture-removal",
  ]);
  assert.deepEqual(detectTestContractHazards("tests/not-sqlite.test.ts",
    "afterEach(() => rm(root, { recursive: true }));"), []);
});

test("baseline rejects new fingerprints or additional copies, never masks new debt", () => {
  const old = findingsToBaseline([
    { path: "tests/a.test.ts", rule: "elapsed-time-assertion", expression: "one", line: 4 },
  ]);
  assert.deepEqual(addedHazards(old, old), []);
  const latest = findingsToBaseline([
    { path: "tests/a.test.ts", rule: "elapsed-time-assertion", expression: "one", line: 9 },
    { path: "tests/a.test.ts", rule: "elapsed-time-assertion", expression: "one", line: 10 },
    { path: "tests/b.test.ts", rule: "sqlite-direct-fixture-removal", expression: "rm(root)", line: 3 },
  ]);
  assert.equal(addedHazards(latest, old).length, 2);
});
