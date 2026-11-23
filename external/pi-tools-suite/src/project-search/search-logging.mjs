/**
 * Shared Pix diagnostics for search indexing. No independent writer, files,
 * work queues or timers: Pix owns the only JSONL sink at ~/.config/pi/logs.
 * Standalone Pi has no Pix sink and silently skips these optional records.
 */
const PIX_SINK = Symbol.for("pix.diagnostics.sink");
const INDEX_FAILURE_PHASES = new Set([
  "policy", "embedding", "sweep", "discovery", "selection", "title",
  "indexing", "finalize", "unknown",
]);
const INDEX_PROGRESS_PHASES = new Set([
  "waiting_for_lease", "reading", "checking_cache", "provider", "saving",
]);
const INDEX_FAILURE_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "EBUSY", "ENOSPC", "EMFILE", "ETIMEDOUT",
  "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_IOERR", "SQLITE_CORRUPT",
  "SQLITE_READONLY", "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_NOTADB", "SEARCH_WORK_NEEDS_CONTINUE",
]);
const INDEX_FAILURE_TYPES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "AbortError",
  "SearchUnavailableError", "SearchWorkNeedsContinueError", "SqliteError",
]);
const SKIP_REASONS = new Set([
  "missing_parent", "line_exceeds_limit", "invalid_json", "file_changed",
  "stat_failed", "empty_transcript", "session_id_mismatch", "workspace_mismatch",
  "cyclic_parent_chain", "unreadable", "unrecognized_format", "invalid_session",
  "file_exceeds_configured_limit",
]);
const NUMERIC_FIELDS = [
  "sessionsTotal", "sessionsChecked", "sessionsSkipped", "chunksDiscovered",
  "cachedChunks", "savedVectors", "requestsStarted", "requestsCompleted", "elapsedMs",
];
const LOG_WINDOW_MS = 300_000;
const MAX_RECENT = 128;
const recent = new Map();

/** Fixed cause categories. Messages are matched only against Pix-owned texts and
 * are never logged; node:sqlite reports `ERR_SQLITE_ERROR` plus a numeric errcode. */
const INDEX_FAILURE_CAUSES = new Set([
  "busy", "compat", "provider", "io", "corrupt", "ownership", "policy", "needs_continue", "other",
]);
const SQLITE_ERRCODES = new Map([
  [5, "SQLITE_BUSY"], [6, "SQLITE_LOCKED"], [8, "SQLITE_READONLY"], [10, "SQLITE_IOERR"],
  [11, "SQLITE_CORRUPT"], [13, "SQLITE_FULL"], [14, "SQLITE_CANTOPEN"], [26, "SQLITE_NOTADB"],
]);
const CODE_CAUSES = new Map([
  ["SQLITE_BUSY", "busy"], ["SQLITE_LOCKED", "busy"], ["EBUSY", "busy"],
  ["SQLITE_CORRUPT", "corrupt"], ["SQLITE_NOTADB", "corrupt"],
  ["SQLITE_IOERR", "io"], ["SQLITE_READONLY", "io"], ["SQLITE_FULL", "io"], ["SQLITE_CANTOPEN", "io"],
  ["ENOENT", "io"], ["EACCES", "io"], ["EPERM", "io"], ["ENOSPC", "io"], ["EMFILE", "io"],
  ["ETIMEDOUT", "provider"], ["SEARCH_WORK_NEEDS_CONTINUE", "needs_continue"],
]);
const MESSAGE_CAUSES = [
  [/^Search (?:index|source) busy; update deferred$|database is (?:locked|busy)/i, "busy"],
  [/^Incompatible (?:embedding cache|search index schema)/, "compat"],
  [/^Semantic .*search unavailable|^Search provider unavailable$|^Invalid embedding (?:response|batch)$|^Search credentials unavailable/, "provider"],
  [/^Search (?:work|provider) ownership expired$/, "ownership"],
  [/search source policy|^Search source .*disabled|^Search authorization (?:revoked|changed)$/i, "policy"],
  [/^Unsafe search directory$|unable to open database|disk I\/O error|database or disk is full|readonly database/i, "io"],
  [/database disk image is malformed|file is not a database/i, "corrupt"],
];
function sqliteCode(error) {
  const errcode = error?.errcode;
  return error?.code === "ERR_SQLITE_ERROR" && Number.isSafeInteger(errcode) ? SQLITE_ERRCODES.get(errcode & 0xff) : undefined;
}
export function classifyIndexFailure(error) {
  try {
    const raw = sqliteCode(error) ?? error?.code;
    const code = INDEX_FAILURE_CODES.has(raw) ? raw : undefined;
    const errorType = INDEX_FAILURE_TYPES.has(error?.name) ? error.name : "OtherError";
    let cause = CODE_CAUSES.get(raw);
    if (!cause) {
      const message = typeof error?.message === "string" ? error.message : "";
      cause = MESSAGE_CAUSES.find(([pattern]) => pattern.test(message))?.[1] ?? "other";
    }
    return { errorType, cause, ...(code ? { code } : {}) };
  } catch { return { errorType: "OtherError", cause: "other" }; }
}

/** A fixed-size, metadata-only event envelope. Never pass IDs, paths, query text,
 * exception strings, provider bodies or transcript content into the shared log. */
export function logSearchDiagnostic(root, diagnostic) {
  try {
    if (!diagnostic || typeof diagnostic !== "object") return Promise.resolve();
    const sink = globalThis[PIX_SINK];
    if (typeof sink !== "function") return Promise.resolve();
    let level, event, details = {};
    if (diagnostic.event === "session_index_progress") {
      const status = diagnostic.status;
      if (status === "failed") { level = "warn"; event = "search:index-failed"; }
      else if (status === "incomplete") { level = "warn"; event = "search:index-incomplete"; }
      else if (status === "completed" && Number(diagnostic.savedVectors) > 0) {
        level = "debug"; event = "search:index-saved";
      } else return Promise.resolve(); // No per-run started/running/empty-completed noise.
      details.phase = INDEX_PROGRESS_PHASES.has(diagnostic.phase) ? diagnostic.phase : "unknown";
      for (const key of NUMERIC_FIELDS) {
        const value = diagnostic[key];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1e9) details[key] = value;
      }
      if (status === "failed") {
        details.errorType = INDEX_FAILURE_TYPES.has(diagnostic.errorType) ? diagnostic.errorType : "OtherError";
        if (INDEX_FAILURE_CODES.has(diagnostic.code)) details.code = diagnostic.code;
        details.cause = INDEX_FAILURE_CAUSES.has(diagnostic.cause) ? diagnostic.cause : "other";
      }
    } else if (diagnostic.event === "session_transcript_skipped") {
      level = diagnostic.reason === "file_changed" ? "debug" : "warn";
      event = "search:transcript-skipped";
      details.reason = SKIP_REASONS.has(diagnostic.reason) ? diagnostic.reason : "other";
      const code = INDEX_FAILURE_CODES.has(diagnostic.code) ? diagnostic.code : undefined;
      if (code) details.code = code;
    } else if (diagnostic.event === "session_indexing_stopped") {
      level = "warn"; event = "search:background-failed";
      details.reason = ["candidate_failed", "needs_continue", "worker_failed"].includes(diagnostic.reason)
        ? diagnostic.reason : "worker_failed";
      details.phase = INDEX_FAILURE_PHASES.has(diagnostic.phase) ? diagnostic.phase : "unknown";
      if (INDEX_FAILURE_TYPES.has(diagnostic.errorType)) details.errorType = diagnostic.errorType;
      if (INDEX_FAILURE_CODES.has(diagnostic.code)) details.code = diagnostic.code;
      details.cause = INDEX_FAILURE_CAUSES.has(diagnostic.cause) ? diagnostic.cause : "other";
      if (Number.isSafeInteger(diagnostic.suppressed) && diagnostic.suppressed > 0) details.suppressed = diagnostic.suppressed;
    } else return Promise.resolve(); // Slash-command output is not a diagnostic event.

    if (level === "warn") {
      const key = `${root}\0${event}\0${details.reason ?? ""}\0${details.phase ?? ""}\0${details.code ?? ""}\0${details.errorType ?? ""}\0${details.cause ?? ""}`;
      const now = Date.now();
      const previous = recent.get(key);
      // Background worker already coalesced its own events and repeat counter.
      const coalesce = !(event === "search:background-failed" && details.reason === "worker_failed");
      if (coalesce && previous && now >= previous.at && now - previous.at < LOG_WINDOW_MS) {
        previous.suppressed++;
        return Promise.resolve();
      }
      if (coalesce) {
        if (!previous && recent.size >= MAX_RECENT) recent.delete(recent.keys().next().value);
        recent.set(key, { at: now, suppressed: 0 });
        if (previous?.suppressed) details.suppressed = previous.suppressed;
      }
    }
    // Never await an IPC/file operation from inside indexing.
    void Promise.resolve().then(() => sink(level, event, details, { project: root, module: "search.index" })).catch(() => {});
  } catch { /* Optional reporting cannot affect source indexing or calls. */ }
  return Promise.resolve();
}

/** A second layer of coalescing for failures preceding per-session indexing. */
export function isExpectedIndexCancellation(error) {
  return error?.name === "AbortError"
    || (error?.name === "Error" && error?.message === "Search source selection changed");
}
export function createBackgroundIndexFailureLogger({ write = logSearchDiagnostic, now = Date.now } = {}) {
  const history = new Map();
  return (root, error, phase = "unknown") => {
    try {
      if (isExpectedIndexCancellation(error)) return;
      const { code, errorType, cause } = classifyIndexFailure(error);
      const reason = code === "SEARCH_WORK_NEEDS_CONTINUE" ? "needs_continue" : "worker_failed";
      const safePhase = INDEX_FAILURE_PHASES.has(phase) ? phase : "unknown";
      const key = `${root}\0${reason}\0${safePhase}\0${code ?? ""}\0${errorType}\0${cause}`;
      const current = now();
      const previous = history.get(key);
      if (previous && current >= previous.at && current - previous.at < LOG_WINDOW_MS) {
        previous.suppressed++;
        return;
      }
      if (!previous && history.size >= MAX_RECENT) history.delete(history.keys().next().value);
      history.set(key, { at: current, suppressed: 0 });
      const record = { event: "session_indexing_stopped", reason, phase: safePhase,
        errorType, cause, ...(code ? { code } : {}),
        ...(previous?.suppressed ? { suppressed: previous.suppressed } : {}) };
      void Promise.resolve().then(() => write(root, record)).catch(() => {});
    } catch { /* Optional diagnostics. */ }
  };
}
export const logBackgroundIndexFailure = createBackgroundIndexFailureLogger();
