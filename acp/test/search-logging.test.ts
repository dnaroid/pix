import assert from "node:assert/strict";
import { test } from "node:test";
import { logSearchDiagnostic } from "../src/search/search-logging.js";

test("index diagnostics use only the shared Pix sink, without progress spam or private payloads", async () => {
  const symbol = Symbol.for("pix.diagnostics.sink");
  const globals = globalThis as Record<symbol, unknown>;
  const before = globals[symbol];
  const rows: Array<{ level: string; event: string; details: Record<string, unknown>; scope: unknown }> = [];
  globals[symbol] = (level: string, event: string, details: Record<string, unknown>, scope: unknown) => {
    rows.push({ level, event, details, scope });
  };
  const root = `/tmp/search-shared-logging-${process.pid}`;
  try {
    for (const status of ["started", "running", "completed", "cancelled"]) {
      await logSearchDiagnostic(root, { event: "session_index_progress", status, sessionsTotal: 1, savedVectors: 0 });
    }
    await logSearchDiagnostic(root, { event: "search_command", message: "PRIVATE query and provider settings" });
    await logSearchDiagnostic(root, { event: "session_index_progress", status: "completed", savedVectors: 2, sessionsTotal: 3 });
    await logSearchDiagnostic(root, { event: "session_index_progress", status: "failed", phase: "provider",
      errorType: "Error", code: "SQLITE_BUSY", requestsStarted: 1, message: "PRIVATE error body" });
    for (let i = 0; i < 50; i++) {
      await logSearchDiagnostic(root, { event: "session_transcript_skipped", reason: "missing_parent",
        sessionId: "private-user-session", path: "/private/secret.jsonl", parentId: "PRIVATE_PARENT" });
    }
    await Promise.resolve();
    assert.deepEqual(rows.map(row => row.event), ["search:index-saved", "search:index-failed", "search:transcript-skipped"]);
    assert.deepEqual(rows.map(row => row.level), ["debug", "warn", "warn"]);
    assert.equal(rows[1]?.details.errorType, "Error");
    assert.equal(rows[1]?.details.code, "SQLITE_BUSY");
    assert.equal(rows[1]?.details.phase, "provider");
    assert.equal(rows[2]?.details.reason, "missing_parent");
    assert.deepEqual(rows[2]?.scope, { project: root, module: "search.index" });
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|private-user-session|secret\.jsonl|private\/secret/);
  } finally {
    if (before === undefined) delete globals[symbol];
    else globals[symbol] = before;
  }
});

test("an unavailable or throwing shared sink never changes an indexing outcome", async () => {
  const symbol = Symbol.for("pix.diagnostics.sink");
  const globals = globalThis as Record<symbol, unknown>;
  const before = globals[symbol];
  try {
    delete globals[symbol];
    await assert.doesNotReject(logSearchDiagnostic("/project", { event: "session_index_progress", status: "failed" }));
    globals[symbol] = () => { throw new Error("storage unavailable"); };
    await assert.doesNotReject(logSearchDiagnostic("/project", { event: "session_index_progress", status: "failed" }));
    await Promise.resolve();
  } finally {
    if (before === undefined) delete globals[symbol];
    else globals[symbol] = before;
  }
});
