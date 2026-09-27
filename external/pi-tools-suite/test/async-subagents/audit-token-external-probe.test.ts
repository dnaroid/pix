import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test.skipIf(process.platform !== "darwin")("macOS task_name_for_pid audit token externally acquired from non-cooperating exec'd child rejects stale generation and kills only exact token", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-audit-external-"));
  try {
    const binary = join(dir, "probe");
    const source = join(import.meta.dir, "fixtures/audit-token-external-probe.c");
    const compile = spawnSync("xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", source, "-lbsm", "-o", binary], { timeout: 20_000, encoding: "utf8" });
    expect(compile.status, compile.stderr || compile.error?.message).toBe(0);
    const probe = spawnSync(binary, [], { timeout: 18_000, encoding: "utf8" });
    expect(probe.status, `${probe.stdout}\n${probe.stderr}\n${probe.error?.message}`).toBe(0);
    expect(probe.stdout).toMatch(/pid_version=\d+ uniq_idversion=\d+ tnf=0 port_released=1 mismatch_return=-?\d+ mismatch_errno=\d+ exact_return=0 exact_errno=0 exit_signal=9/);
    console.log(probe.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
