import assert from "node:assert/strict";
import { ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ciPlan, repoRoot, resolveCommand, runGate } from "../scripts/check-ci.mjs";

mkdirSync(join(repoRoot, ".pi/artifacts"), { recursive: true });

test("CI plan covers the shared matrix without unsupported Desktop requirements", () => {
  const ids = (platform: NodeJS.Platform) => ciPlan(platform).map((s: { id: string }) => s.id);
  assert.deepEqual(ids("win32"), ["root", "acp", "tools-suite"]);
  assert.deepEqual(ids("linux"), ["root", "acp", "tools-suite", "browser-e2e"]);
  assert.deepEqual(ids("darwin"), ["root", "acp", "desktop-check", "desktop-test", "rust-fmt", "rust-check", "rust-test", "tools-suite"]);
  assert.throws(() => ciPlan("unsupported" as NodeJS.Platform), /Unsupported CI host/);
  for (const platform of ["linux", "darwin", "win32"] as const) {
    assert.ok(ciPlan(platform).find((s: { id: string; isolatedHome?: boolean }) => s.id === "tools-suite")?.isolatedHome);
  }
});

test("workflow and npm entrypoint use the shared gate", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:ci"], "node scripts/check-ci.mjs");
  const suite = JSON.parse(readFileSync(join(repoRoot, "external/pi-tools-suite/package.json"), "utf8"));
  assert.ok(suite.scripts.test.startsWith("bun test --isolate --timeout 20000 test &&"));
  const workflow = readFileSync(join(repoRoot, ".github/workflows/check.yml"), "utf8");
  assert.match(workflow, /run: npm run check:ci/);
  assert.match(workflow, /include-hidden-files: true/);
  assert.doesNotMatch(workflow, /run: npm run check\s*$/m);
  assert.match(workflow, /check-ci-\*\/summary.json/);
});

test("npm resolution preserves the caller-selected CLI and handles direct Windows invocation", () => {
  const step = { command: "npm", args: ["run", "check:acp"] };
  assert.deepEqual(resolveCommand(step, { npm_execpath: "/path with spaces/npm-cli.js" }, "win32"),
    [process.execPath, ["/path with spaces/npm-cli.js", "run", "check:acp"]]);
  assert.deepEqual(resolveCommand(step, {}, "win32"), ["cmd.exe", ["/d", "/s", "/c", "npm", "run", "check:acp"]]);
  assert.deepEqual(resolveCommand(step, {}, "linux"), ["npm", ["run", "check:acp"]]);
  assert.deepEqual(resolveCommand({ command: "cargo", args: ["check"] }, {}, "darwin"), ["cargo", ["check"]]);
});

test("gate executes in order, isolates only configuration-sensitive steps, and saves summary", async (t) => {
  const parent = mkdtempSync(join(repoRoot, ".pi/artifacts/ci-gate-test-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const calls: Array<{ command: string; args: string[]; options: { env: NodeJS.ProcessEnv; cwd: string } }> = [];
  const signals = new EventEmitter();
  const env = { HOME: "original-home", USERPROFILE: "original-profile", PIX_CONFIG_PROFILE: "desktop",
    PIX_BRAINSTORM_HOST_URL: "http://127.0.0.1:1234/", PIX_BRAINSTORM_HOST_TOKEN: "test-token", PATH: process.env.PATH };
  const launch = (command: string, args: string[], options: SpawnOptions) => {
    assert.ok(options.env);
    assert.equal(typeof options.cwd, "string");
    calls.push({ command, args, options: { env: options.env, cwd: options.cwd as string } });
    const child = new ChildProcess();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };
  const result = await runGate({ artifactParent: parent, platform: "win32", env, signals, launch, report: () => {} });
  assert.equal(result.status, "passed");
  assert.deepEqual(result.notRun, []);
  assert.deepEqual(result.results.map((r: { id: string }) => r.id), ["root", "acp", "tools-suite"]);
  assert.equal(calls[0].options.env.HOME, "original-home");
  assert.ok(calls.every((call) => call.options.env.PIX_CONFIG_PROFILE === undefined));
  assert.ok(calls.every((call) => call.options.env.PIX_BRAINSTORM_HOST_URL === undefined));
  assert.ok(calls.every((call) => call.options.env.PIX_BRAINSTORM_HOST_TOKEN === undefined));
  assert.equal(calls[2].options.env.CI, "true");
  assert.notEqual(calls[2].options.env.HOME, "original-home");
  assert.equal(calls[2].options.env.USERPROFILE, calls[2].options.env.HOME);
  assert.equal(calls[2].options.env.PI_CODING_AGENT_DIR, join(calls[2].options.env.HOME!, ".pi/agent"));
  assert.equal(env.HOME, "original-home");
  assert.equal(env.PIX_CONFIG_PROFILE, "desktop");
  assert.equal(env.PIX_BRAINSTORM_HOST_URL, "http://127.0.0.1:1234/");
  assert.equal(env.PIX_BRAINSTORM_HOST_TOKEN, "test-token");
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(JSON.parse(readFileSync(result.summaryPath, "utf8")).status, "passed");
});

for (const scenario of ["nonzero", "spawn-error", "signalled", "interrupt"] as const) {
  test(`gate fails closed on ${scenario} and never starts later steps`, async (t) => {
    const parent = mkdtempSync(join(repoRoot, ".pi/artifacts/ci-gate-test-"));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const signals = new EventEmitter();
    let calls = 0;
    let stopped = 0;
    const launch = () => {
      calls++;
      const child = new ChildProcess();
      queueMicrotask(() => {
        if (scenario === "spawn-error") child.emit("error", new Error("ENOENT test"));
        if (scenario === "interrupt") signals.emit("SIGINT");
        child.emit("close", scenario === "nonzero" ? 7 : scenario === "interrupt" ? 0 : null, scenario === "signalled" ? "SIGKILL" : null);
      });
      return child;
    };
    const result = await runGate({ artifactParent: parent, platform: "win32", signals, launch,
      stopChild: () => { stopped++; }, report: () => {} });
    assert.equal(calls, 1);
    assert.deepEqual(result.notRun, ["acp", "tools-suite"]);
    assert.equal(result.status, ["signalled", "interrupt"].includes(scenario) ? "incomplete" : "failed");
    assert.equal(result.exitCode, scenario === "nonzero" ? 7 : scenario === "interrupt" ? 130 : 1);
    assert.equal(stopped, scenario === "interrupt" ? 1 : 0);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  });
}

test("real child output is retained and a nonzero exit stops the gate", async (t) => {
  const parent = mkdtempSync(join(repoRoot, ".pi/artifacts/ci-gate-test-"));
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const result = await runGate({ artifactParent: parent, report: () => {}, plan: [
    { id: "success", command: process.execPath, args: ["-e", "console.log('stdout-marker'); console.error('stderr-marker')"] },
    { id: "failure", command: process.execPath, args: ["-e", "process.exitCode = 9"] },
    { id: "not-started", command: process.execPath, args: ["-e", "process.exitCode = 0"] },
  ] });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 9);
  assert.deepEqual(result.notRun, ["not-started"]);
  const log = readFileSync(result.results[0].logPath, "utf8");
  assert.match(log, /stdout-marker/);
  assert.match(log, /stderr-marker/);
});
