import type { AcpExit } from "./acp-client-types";

/** Diagnostic text is untrusted: strip terminal controls and common credentials. */
export function cleanAcpDiagnostic(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, "[redacted]")
    .replace(/\b((?:[a-z_]*api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/giu, "$1[redacted]")
    .slice(-64 * 1024);
}

export function acpCrashReport(exit: AcpExit, diagnostics: readonly string[]): { message: string; content: string } {
  const summary = cleanAcpDiagnostic(exit.error ?? `pix-acp exited${exit.code === null ? "" : ` with code ${exit.code}`}`);
  // Prefer the native snapshot: the final batch of stderr events can arrive
  // after exit and is deliberately ignored by the connection ownership guard.
  const stderr = cleanAcpDiagnostic(exit.stderr ?? diagnostics.join("\n"));
  const lines = stderr.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).reverse();
  const reason = lines.find((line) => /\bfatal\b/iu.test(line))
    ?? lines.find((line) => !/^at\s/u.test(line));
  return {
    message: summary.slice(0, 600) + (reason ? ` — ${reason.slice(0, 600)}` : " — stderr unavailable"),
    content: `${new Date().toISOString()}\n${summary}\n\n--- stderr tail (bounded; common credentials redacted) ---\n${stderr || "(no stderr captured)"}\n`,
  };
}
