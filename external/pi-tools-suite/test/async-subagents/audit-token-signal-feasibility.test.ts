import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test.skipIf(process.platform !== "darwin")("macOS audit-token signal rejects stale generation and delivers to own waitable child", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-audit-signal-"));
  try {
    const binary = join(dir, "probe");
    const source = join(import.meta.dir, "fixtures/audit-token-signal-feasibility.c");
    const compile = spawnSync("xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", source, "-lbsm", "-o", binary], { timeout: 20_000, encoding: "utf8" });
    expect(compile.status, compile.stderr || compile.error?.message).toBe(0);
    const probe = spawnSync(binary, [], { timeout: 18_000, encoding: "utf8" });
    expect(probe.status, `${probe.stdout}\n${probe.stderr}\n${probe.error?.message}`).toBe(0);
    expect(probe.stdout).toMatch(/mismatch_return=-?\d+ mismatch_errno=\d+ exact_return=0 exact_errno=0 exit_signal=30/);
    console.log(probe.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
