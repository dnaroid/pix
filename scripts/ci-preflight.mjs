import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, runGate } from "./check-ci.mjs";

const suiteTest = (...names) => names.map(name => join(repoRoot, "external/pi-tools-suite/test", name));
const bun = (id, args) => ({ id, command: "bun", args: ["test", "--isolate", "--timeout", "60000", ...args], isolatedHome: true });
const node = (id, args, isolatedHome = false) => ({ id, command: process.execPath, args, isolatedHome });

/** Small, high-risk regression sample. The full native CI gate is still required. */
export function preflightPlan(platform = process.platform) {
  if (!["linux", "darwin", "win32"].includes(platform)) throw new Error(`Unsupported CI host: ${platform}`);
  const plan = [
    node("test-contracts", [join(repoRoot, "scripts/ci-test-contracts.mjs"), "--check"]),
  ];
  if (platform === "win32") {
    plan.push(
      bun("windows-lifecycle", suiteTest(
        "fs-retry.test.ts", "headless-broker-reply.test.ts",
        "headless-broker-lifecycle.test.ts", "headless-broker.test.ts",
      )),
      bun("windows-sqlite", [
        ...suiteTest("native-document-index.test.ts", "native-project-search.test.ts"),
        "--test-name-pattern", "isolates sources/models and embeds documents only|indexes Godot source",
      ]),
      bun("windows-pty", [
        ...suiteTest("async-subagents/ui-qa-runner.test.ts"),
        "--test-name-pattern", "does not retain the exit assertion timeout after the PTY exits",
      ]),
    );
  } else if (platform === "linux") {
    plan.push(
      bun("linux-ast", [
        ...suiteTest("headless.test.ts"),
        "--test-name-pattern", "uses the real Pix AST engine and enforces read-only restrictions",
      ]),
      bun("linux-lsp", suiteTest("lsp-broker-client.test.ts", "lsp-broker.test.ts")),
    );
  } else {
    plan.push(node("macos-process-cleanup", [
      "--import", "tsx", "--test", "--test-concurrency=1",
      "--test-name-pattern", "provider publishes an output-limit response whose process exited before termination landed|group.*EPERM|EPERM.*group",
      ...suiteTest(
        "claude-code-provider/upstream/unit/provider.case.js",
        "claude-code-provider/upstream/unit/process-utils.case.js",
      ),
    ], true));
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--list") console.log(JSON.stringify(preflightPlan(), null, 2));
  else if (args.length > 0) { console.error("Usage: node scripts/ci-preflight.mjs [--list]"); process.exitCode = 1; }
  else {
    try {
      // Preflight uses the same isolation and artifact protocol as check:ci.
      // Never mistake a smoke pass for the platform's full native CI plan.
      const summary = await runGate({ plan: preflightPlan(), artifactParent: join(repoRoot, ".pi/artifacts/ci-preflight-runs") });
      process.exitCode = summary.exitCode;
    } catch (error) { console.error(error); process.exitCode = 1; }
  }
}
