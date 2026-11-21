import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { preflightPlan } from "../scripts/ci-preflight.mjs";
import { ciPlan, repoRoot } from "../scripts/check-ci.mjs";

test("preflight checks dependency parity early and selects platform regressions, not the full gate", () => {
  const ids = (platform: NodeJS.Platform) => preflightPlan(platform).map(step => step.id);
  const shared = ["suite-dependencies", "test-contracts"];
  assert.deepEqual(ids("win32"), [...shared, "windows-lifecycle", "windows-sqlite", "windows-pty"]);
  assert.deepEqual(ids("linux"), [...shared, "linux-ast", "linux-lsp"]);
  assert.deepEqual(ids("darwin"), [...shared, "macos-process-cleanup"]);
  assert.ok(preflightPlan("win32").slice(shared.length).every(step => step.command === "bun"),
    "Windows Bun tests must use CI's cmd.exe command resolution");
  assert.throws(() => preflightPlan("solaris" as NodeJS.Platform), /Unsupported CI host/);
  for (const platform of ["win32", "linux", "darwin"] as const) {
    const plan = preflightPlan(platform);
    assert.equal(plan[0].command, process.execPath);
    assert.deepEqual(plan[0].args, ["--import", "tsx", "--test", join(repoRoot, "tests/pi-tools-suite-dependencies.test.ts")]);
    assert.ok(plan.slice(shared.length).every(step => step.isolatedHome), "sensitive suite preflight must isolate HOME");
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
