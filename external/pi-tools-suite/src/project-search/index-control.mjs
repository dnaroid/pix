/** Cross-process manual-run coordination. Separate from index databases so
 * heartbeat/status writes cannot invalidate an index's physical snapshot. */
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, safeDirectory, SOURCE_FILES, sourceDirectories, globalSearchDirectory } from "./source-work.mjs";
import { probeSnapshots } from "./snapshot-probe.mjs";

export const MANUAL_RUN_TTL = 60_000;
const sources = [...Object.keys(SOURCE_FILES), "all"];
const validObservation = value => value && !value.error && /^[a-f0-9]{64}$/.test(value.source)
  && /^[a-f0-9]{64}$/.test(value.index) && Number.isFinite(value.checkedAt);
const absent = error => { if (error.code !== "ENOENT") throw error; };

async function connect(root, write, create = write, global = false) {
  root = resolve(root);
  if (await realpath(root) !== root) throw new Error("Unsafe project path");
  for (const directory of sourceDirectories(root, global ? "settings" : "tasks")) {
    if (create) await safeDirectory(directory);
    else {
      const info = await lstat(directory).catch(absent);
      if (!info) return;
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe search directory");
    }
  }
  const filename = global ? join(globalSearchDirectory(), "manual-runs.sqlite") : join(root, ".pi/search/manual-runs.sqlite");
  if (!create && !await lstat(filename).catch(absent)) return;
  const db = await openDatabase(filename, { readOnly: !write });
  try {
    db.exec("PRAGMA busy_timeout=200; PRAGMA trusted_schema=OFF");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version !== 0 && version !== 1) throw new Error("Unsupported manual-run storage");
    if (!version && create) {
      if (db.prepare("SELECT name FROM sqlite_master").all().length) throw new Error("Unrecognized manual-run storage");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS manual_runs (source TEXT PRIMARY KEY, token TEXT NOT NULL,
          state TEXT NOT NULL, expires INTEGER NOT NULL, started INTEGER NOT NULL, updated INTEGER NOT NULL,
          stop INTEGER NOT NULL, before_json TEXT, receipt_json TEXT, result_json TEXT);
          PRAGMA user_version=1; COMMIT`);
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    const tables = db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    if (tables.length !== 1 || tables[0].name !== "manual_runs" || tables[0].type !== "table") throw new Error("Invalid manual-run schema");
    const columns = db.prepare("PRAGMA table_info(manual_runs)").all().map(row => row.name).join(",");
    if (columns !== "source,token,state,expires,started,updated,stop,before_json,receipt_json,result_json") throw new Error("Invalid manual-run columns");
    return db;
  } catch (error) { db.close(); throw error; }
}

export async function readManualRuns(root) {
  const local = await readRuns(root, false);
  delete local.settings; // Old project receipts cannot certify the global cache.
  const global = await readRuns(root, true);
  return { ...local, ...(global.settings ? { settings: global.settings } : {}) };
}
async function readRuns(root, global) {
  const db = await connect(root, false, false, global);
  if (!db) return {};
  try {
    const rows = db.prepare("SELECT * FROM manual_runs LIMIT 8").all();
    if (rows.length > 7) throw new Error("Invalid manual runs");
    return Object.fromEntries(rows.map(row => {
      if (!sources.includes(row.source)) throw new Error("Invalid manual source");
      const active = ["running", "stopping"].includes(row.state);
      const expired = active && row.expires <= Date.now();
      return [row.source, { state: expired ? "interrupted" : row.state, started: row.started, updated: row.updated,
        receipt: row.receipt_json ? JSON.parse(row.receipt_json) ?? undefined : undefined,
        result: row.result_json ? JSON.parse(row.result_json) ?? undefined : undefined }];
    }));
  } finally { db.close(); }
}

/** Tokens fence late finish/heartbeat, and stop never signals an arbitrary PID.
 * Index writers retain their existing source/provider leases independently. */
export async function controlManualIndex(root, request) {
  const { action, source, token, settingsDigest } = request;
  if (!["begin", "heartbeat", "finish", "stop"].includes(action) || !sources.includes(source)
    || (settingsDigest !== undefined && !/^[a-f0-9]{64}$/.test(settingsDigest))
    || (["heartbeat", "finish"].includes(action) && (typeof token !== "string" || token.length > 80))) throw new Error("Invalid manual control");
  const observe = async () => (await probeSnapshots(root, { operation: "snapshot-probe", sources: [source],
    ...(settingsDigest ? { settingsDigest } : {}) })).observations[source];
  const observation = source !== "all" && ["begin", "finish"].includes(action) ? await observe().catch(() => undefined) : undefined;
  // stop/heartbeat/finish must not create missing storage.
  const db = await connect(root, true, action === "begin", source === "settings");
  if (!db) return { accepted: false };
  return mutate(db, action, source, token, observation, request);
}

function mutate(db, action, source, token, observation, request) {
  try {
    db.exec("PRAGMA busy_timeout=200; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE");
    const now = Date.now();
    const row = db.prepare("SELECT * FROM manual_runs WHERE source=?").get(source);
    if (action === "begin") {
      if (row && ["running", "stopping"].includes(row.state) && row.expires > now) throw new Error("Manual indexing already running; stop or wait");
      const owner = randomUUID();
      db.prepare(`INSERT INTO manual_runs VALUES(?,?,'running',?,?,?,0,?,NULL,NULL)
        ON CONFLICT(source) DO UPDATE SET token=excluded.token,state='running',expires=excluded.expires,
        started=excluded.started,updated=excluded.updated,stop=0,before_json=excluded.before_json,receipt_json=NULL,result_json=NULL`)
        .run(source, owner, now + MANUAL_RUN_TTL, now, now, JSON.stringify(observation ?? null));
      db.exec("COMMIT");
      return { accepted: true, token: owner };
    }
    const owned = row && ["running", "stopping"].includes(row.state) && row.expires > now;
    if (!owned || ((action !== "stop" || token !== undefined) && row.token !== token)) { db.exec("COMMIT"); return { accepted: false }; }
    if (action === "stop") db.prepare("UPDATE manual_runs SET stop=1,state='stopping',updated=? WHERE source=?").run(now, source);
    else if (action === "heartbeat") db.prepare("UPDATE manual_runs SET expires=?,updated=? WHERE source=?").run(now + MANUAL_RUN_TTL, now, source);
    else {
      const value = request.result;
      const cancelled = Boolean(row.stop || request.cancelled);
      const valid = value?.source === source && typeof value.complete === "boolean";
      const before = JSON.parse(row.before_json ?? "null");
      const stable = source === "all" || validObservation(before) && validObservation(observation) && before.source === observation.source;
      const receipt = !cancelled && valid && validObservation(before) && validObservation(observation) && observation.indexPresent === true
        ? { source: before.source, index: observation.index, checkedAt: observation.checkedAt, complete: value.complete && stable } : undefined;
      const result = valid ? { source, complete: source === "all" ? value.complete && !cancelled : Boolean(receipt?.complete),
        ...Object.fromEntries(["indexed", "total"].filter(key => Number.isSafeInteger(value[key]) && value[key] >= 0).map(key => [key, value[key]])),
        message: cancelled ? "Stopped; committed batches retained." : !stable ? "Snapshot unverified; Continue to verify coverage." : "Manual indexing pass finished." } : undefined;
      const state = cancelled ? "cancelled" : !valid ? "error" : result.complete ? "complete" : "partial";
      db.prepare("UPDATE manual_runs SET state=?,expires=0,updated=?,receipt_json=?,result_json=? WHERE source=?")
        .run(state, now, JSON.stringify(receipt ?? null), JSON.stringify(result ?? null), source);
      db.exec("COMMIT");
      return { accepted: true, result, receipt, state };
    }
    db.exec("COMMIT");
    return { accepted: true, stop: action === "stop" || Boolean(row.stop) };
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  finally { db.close(); }
}
