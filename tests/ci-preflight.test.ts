import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { preflightPlan } from "../scripts/ci-preflight.mjs";
import { ciPlan, repoRoot } from "../scripts/check-ci.mjs";

test("preflight selects actual cross-platform lifecycle regressions, not the full gate", () => {
  const ids = (platform: NodeJS.Platform) => preflightPlan(platform).map(step => step.id);
  assert.deepEqual(ids("win32"), ["test-contracts", "windows-lifecycle", "windows-sqlite", "windows-pty"]);
  assert.deepEqual(ids("linux"), ["test-contracts", "linux-ast", "linux-lsp"]);
  assert.deepEqual(ids("darwin"), ["test-contracts", "macos-process-cleanup"]);
  assert.throws(() => preflightPlan("solaris" as NodeJS.Platform), /Unsupported CI host/);
  for (const platform of ["win32", "linux", "darwin"] as const) {
    const plan = preflightPlan(platform);
    assert.ok(plan.slice(1).every(step => step.isolatedHome), "sensitive suite preflight must isolate HOME");
    assert.ok(plan.some(step => step.id === "test-contracts"));
    for (const step of plan) for (const arg of step.args) {
      if (/\.(?:test\.[jt]s|case\.js|mjs)$/.test(arg) && arg.startsWith(repoRoot)) {
        assert.ok(existsSync(arg), `missing smoke regression file: ${arg}`);
      }
    }
    assert.equal(ciPlan(platform).some(step => step.id === "tools-suite"), true,
      "preflight must never replace the full suite");
  }
});

test("workflow runs the short preflight before, not instead of, the shared native gate", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/check.yml"), "utf8");
  const preflight = workflow.indexOf("run: npm run check:ci:preflight");
  const browserInstall = workflow.indexOf("run: npx playwright install --with-deps chromium");
  const full = workflow.indexOf("run: npm run check:ci\n");
  assert.ok(preflight !== -1 && full > preflight);
  assert.ok(browserInstall > preflight && full > browserInstall,
    "Linux installs browser dependencies only after fast preflight succeeds");
  assert.match(workflow, /ci-preflight-runs\/check-ci-\*\/summary\.json/);
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:ci:preflight"], "node scripts/ci-preflight.mjs");
});
