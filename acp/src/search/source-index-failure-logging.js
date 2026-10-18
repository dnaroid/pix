// ACP-only source diagnostics; keep shared protocol twins byte-identical.
import { classifyIndexFailure, isExpectedIndexCancellation } from "./search-logging.js";
const PIX_SINK = Symbol.for("pix.diagnostics.sink");
const LOG_WINDOW_MS = 300_000;
const MAX_RECENT = 128;

/** Fixed categories for ACP-owned error texts. The message itself is never logged. */
const FAILURE_REASON_PATTERNS = [
  [/^Search index busy; update deferred$|^Search source busy; update deferred$/, "busy"],
  [/^Incompatible embedding cache/, "incompatible"],
  [/^Search source selection changed$/, "policy_changed"],
  [/^Search source \w+ is disabled for this project$|^Search source disabled$/, "source_disabled"],
  [/search source policy/i, "policy_invalid"],
  [/^Search authorization (revoked|changed)$/, "authorization_changed"],
  [/^Search (work|provider) ownership expired$/, "ownership_expired"],
  [/^Semantic .* search unavailable; local .*search remains available$/, "provider_unavailable"],
  [/^Task semantic index exceeds size limit$/, "corpus_too_large"],
  [/^Invalid (task|empty task)|^Epic task cannot have a parent$|^Unsafe task database$/, "corpus_invalid"],
  [/database is locked|database is busy/i, "locked"],
];
const SOURCE_FAILURE_REASONS = new Set([...FAILURE_REASON_PATTERNS.map(([, reason]) => reason),
  "needs_continue", "watcher_failed", "aborted", "other"]);
const BACKGROUND_SOURCES = new Set(["settings", "tasks"]);
export function classifyIndexFailureReason(error) {
  try {
    if (error?.code === "SEARCH_WORK_NEEDS_CONTINUE") return "needs_continue";
    if (error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED") return "locked";
    if (error?.name === "AbortError" || error?.name === "TimeoutError") return "aborted";
    const message = typeof error?.message === "string" ? error.message : "";
    for (const [pattern, reason] of FAILURE_REASON_PATTERNS) if (pattern.test(message)) return reason;
    return "other";
  } catch { return "other"; }
}
/** Settings/task background-indexer failure: source + fixed reason, never the message. */
export function createSourceIndexFailureLogger({ sink = () => globalThis[PIX_SINK], now = Date.now } = {}) {
  const history = new Map();
  return (root, source, error, reason) => {
    try {
      if (!BACKGROUND_SOURCES.has(source) || isExpectedIndexCancellation(error)) return;
      const write = sink();
      if (typeof write !== "function") return;
      const safeReason = SOURCE_FAILURE_REASONS.has(reason) ? reason : classifyIndexFailureReason(error);
      const { code, errorType } = error === undefined ? { errorType: undefined } : classifyIndexFailure(error);
      const key = `${root}\0${source}\0${safeReason}\0${code ?? ""}\0${errorType ?? ""}`;
      const current = now();
      const previous = history.get(key);
      if (previous && current >= previous.at && current - previous.at < LOG_WINDOW_MS) { previous.suppressed++; return; }
      if (!previous && history.size >= MAX_RECENT) history.delete(history.keys().next().value);
      history.set(key, { at: current, suppressed: 0 });
      const details = { source, reason: safeReason, ...(errorType ? { errorType } : {}), ...(code ? { code } : {}),
        ...(previous?.suppressed ? { suppressed: previous.suppressed } : {}) };
      void Promise.resolve().then(() => write("warn", "search:source-index-failed", details, { project: root, module: "search.index" })).catch(() => {});
    } catch { /* Optional diagnostics. */ }
  };
}
export const logSourceIndexFailure = createSourceIndexFailureLogger();
