import { describe, expect, it } from "vitest";
import { acpCrashReport, cleanAcpDiagnostic } from "./acp-crash-diagnostics";

const exit = { generation: 1, code: 1, success: false, requested: false, error: null };

describe("ACP crash diagnostics", () => {
  it("prefers the fatal line over stack frames and preserves stack details in the log", () => {
    const report = acpCrashReport({ ...exit, stderr: "[pix-acp] fatal: invalid configuration\n    at startup:42\n" }, []);
    expect(report.message).toBe("pix-acp exited with code 1 — [pix-acp] fatal: invalid configuration");
    expect(report.content).toContain("at startup:42");
  });

  it("cleans common credentials and terminal control sequences in both outputs", () => {
    const report = acpCrashReport({ ...exit, stderr: "\x1b[31mfatal: token=private sk-abcdef Bearer hidden\x1b[0m" }, []);
    for (const output of [report.message, report.content]) {
      expect(output).not.toMatch(/private|abcdef|hidden|\x1b/u);
      expect(output).toContain("[redacted]");
    }
  });

  it("bounds detail and reports missing stderr explicitly", () => {
    expect(cleanAcpDiagnostic("x".repeat(100_000))).toHaveLength(64 * 1024);
    expect(acpCrashReport(exit, []).message).toContain("stderr unavailable");
    expect(acpCrashReport(exit, ["fallback stderr"]).message).toContain("fallback stderr");
    expect(acpCrashReport({ ...exit, stderr: "" }, ["stale stderr"]).message).not.toContain("stale stderr");
    expect(acpCrashReport({ ...exit, stderr: "x".repeat(2000) }, []).message.length).toBeLessThan(700);
  });
});
