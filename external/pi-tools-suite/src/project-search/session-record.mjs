import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { excludeSessionAttachments } from "./session-text.mjs";

const MAX_TEXT_CHARS = 1024 * 1024;
const WORKER_TASK = "pix-search-session-record";

// Parse the complete JSON (including ignored fields), but retain only ancestry
// and public text. A large attachment is not a large public message.
function projectRecord(line) {
  let entry;
  try { entry = JSON.parse(line); }
  catch { return { reason: "invalid_json" }; }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { reason: "invalid_entry" };
  const record = { type: entry.type, id: entry.id, parentId: entry.parentId, cwd: entry.cwd };
  // Bound retained metadata too; never return arbitrary objects from a worker.
  for (const value of Object.values(record)) {
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 4096)) {
      return { reason: "invalid_entry" };
    }
  }
  const m = entry.type === "message" ? entry.message : undefined;
  if (m?.role === "user" || m?.role === "assistant") {
    const blocks = typeof m.content === "string" ? [m.content] : Array.isArray(m.content)
      ? m.content.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text) : [];
    const text = excludeSessionAttachments(blocks.join("\n"));
    if (text.length > MAX_TEXT_CHARS) return { reason: "public_text_exceeds_limit" };
    if (text.trim()) record.message = { id: entry.id, role: m.role, text,
      status: m.role === "user" ? "user" : typeof m.stopReason === "string" && m.stopReason.length <= 100 ? m.stopReason : "unknown" };
  }
  return { entry: record };
}

// Only exceptional large records need a worker. Ordinary session reads avoid
// startup overhead; JSON.parse of image/tool payloads never blocks the host.
export async function parseSessionRecord(line, signal) {
  signal.throwIfAborted();
  if (line.length <= MAX_TEXT_CHARS) return projectRecord(line);
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { task: WORKER_TASK, line }, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 384 },
  });
  let timer, onAbort;
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      worker.once("message", resolve);
      worker.once("error", () => resolve({ reason: "record_worker_failed" }));
      worker.once("exit", () => resolve({ reason: "record_worker_failed" }));
      timer = setTimeout(() => resolve({ reason: "record_worker_timeout" }), 30000);
      if (signal.aborted) onAbort();
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    await worker.terminate();
  }
}

if (!isMainThread && workerData?.task === WORKER_TASK) parentPort.postMessage(projectRecord(workerData.line));
