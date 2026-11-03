import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NativeSessionMetadataCache, readNativeSessionMetadata } from "../src/acp/native-session-metadata.js";
import { nativeSessionDirectory } from "../src/search/session-discovery.js";
import { SessionMapStore } from "../src/acp/session-map.js";

const cwd = resolve("/catalog-project");
const signal = () => new AbortController().signal;
const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const header = (id: string) => line({ type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00Z", parentSession: "/parent.jsonl" });
const user = line({ type: "message", timestamp: "2026-01-02T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "First prompt" }] } });

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = resolve(import.meta.dirname, "../../.pi/artifacts");
  await mkdir(root, { recursive: true });
  const agentDir = await mkdtemp(join(root, "native-metadata-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const directory = nativeSessionDirectory(cwd, agentDir);
  await mkdir(directory, { recursive: true });
  return { agentDir, directory };
}

test("metadata projection matches SDK title and fork fields without transcript retention", async t => {
  const { directory } = await fixture(t);
  const path = join(directory, "a.jsonl");
  await writeFile(path, header("a") + user
    + line({ type: "message", timestamp: "2026-01-03T00:00:00Z", message: { role: "assistant", content: "Answer", timestamp: 1767398400000 } })
    + line({ type: "message", timestamp: "2026-02-01T00:00:00Z", message: { role: "toolResult", content: "not activity" } })
    + line({ type: "session_info", name: " Old name " }) + line({ type: "session_info", name: " Current name " })
    + "malformed line\n");
  const [expected] = await SessionManager.list(cwd, directory);
  const info = await readNativeSessionMetadata(path, signal());
  assert.ok(expected && info);
  for (const field of ["path", "id", "cwd", "name", "firstMessage", "parentSessionPath"] as const) {
    assert.deepEqual(info[field], expected[field], field);
  }
  assert.equal("allMessagesText" in info, false);
  assert.equal("messageCount" in info, false);
  assert.deepEqual(info.modified, (await stat(path)).mtime);
  await appendFile(path, line({ type: "session_info", name: " " }));
  assert.equal((await readNativeSessionMetadata(path, signal()))?.name, undefined, "explicit title clear");
});

test("catalog orders by file modification, not creation or message timestamps", async t => {
  const { agentDir, directory } = await fixture(t);
  const old = join(directory, "old.jsonl"), newer = join(directory, "newer.jsonl");
  await writeFile(old, header("old") + user + line({ type: "session_info", name: "Renamed" }));
  await writeFile(newer, line({ type: "session", version: 3, id: "newer", cwd, timestamp: "2026-02-01T00:00:00Z" }));
  const recent = new Date("2026-04-01T00:00:00Z"), previous = new Date("2026-03-01T00:00:00Z");
  await utimes(old, recent, recent);
  await utimes(newer, previous, previous);
  const cache = new NativeSessionMetadataCache(agentDir);
  const store = new SessionMapStore(join(agentDir, "map.json"), { info() {}, warn() {}, error() {}, debug() {} });
  const refresh = async () => {
    await store.mergeByPiSessionPath((await cache.list(cwd, signal())).map(info => ({
      sessionId: info.id, piSessionId: info.id, piSessionPath: info.path, cwd,
      updatedAt: info.modified.toISOString(),
    })));
    return (await store.list(cwd)).map(record => record.sessionId);
  };
  assert.deepEqual(await refresh(), ["old", "newer"]);
  const latest = new Date("2026-05-01T00:00:00Z");
  await appendFile(newer, line({ type: "session_info", name: "Empty but edited" }));
  await utimes(newer, latest, latest);
  assert.deepEqual(await refresh(), ["newer", "old"]);
  assert.equal((await store.list(cwd))[0]?.updatedAt, latest.toISOString());
});

test("unchanged files are never reread when one session grows, is replaced, or is deleted", async t => {
  const { agentDir, directory } = await fixture(t);
  const a = join(directory, "a.jsonl"), b = join(directory, "b.jsonl");
  await writeFile(a, header("a") + user);
  await writeFile(b, header("b") + user);
  const reads: string[] = [];
  const cache = new NativeSessionMetadataCache(agentDir, async (path, abort) => {
    reads.push(path); return readNativeSessionMetadata(path, abort);
  });
  assert.equal((await cache.list(cwd, signal())).length, 2);
  assert.deepEqual(reads, [a, b]);
  await cache.list(cwd, signal());
  assert.deepEqual(reads, [a, b]);
  await appendFile(a, line({ type: "session_info", name: "Renamed" }));
  assert.equal((await cache.list(cwd, signal())).find(r => r.id === "a")?.name, "Renamed");
  assert.deepEqual(reads, [a, b, a]);

  const previous = await stat(b);
  const replacement = join(directory, "replacement.tmp");
  await writeFile(replacement, header("c") + user); // same size, restored mtime, different inode
  await utimes(replacement, previous.atime, previous.mtime);
  await rename(replacement, b);
  assert.deepEqual((await cache.list(cwd, signal())).map(r => r.id), ["a", "c"]);
  assert.deepEqual(reads, [a, b, a, b]);
  await rm(a);
  assert.deepEqual((await cache.list(cwd, signal())).map(r => r.id), ["c"]);
  assert.deepEqual(reads, [a, b, a, b]);
  await writeFile(a, header("d"));
  assert.deepEqual((await cache.list(cwd, signal())).map(r => r.id), ["d", "c"]);
  cache.clear();
  await cache.list(cwd, signal());
  assert.deepEqual(reads, [a, b, a, b, a, a, b]);
});

test("concurrent growth is not cached under a revision the reader did not consume", async t => {
  const { agentDir, directory } = await fixture(t);
  const path = join(directory, "a.jsonl");
  await writeFile(path, header("a") + user);
  let reads = 0;
  const cache = new NativeSessionMetadataCache(agentDir, async (path, abort) => {
    const info = await readNativeSessionMetadata(path, abort);
    if (++reads === 1) await appendFile(path, line({ type: "session_info", name: "During read" }));
    return info;
  });
  assert.equal((await cache.list(cwd, signal()))[0]?.name, undefined);
  assert.equal((await cache.list(cwd, signal()))[0]?.name, "During read");
  await cache.list(cwd, signal());
  assert.equal(reads, 2);
});

test("failed or aborted reads retry, and project caches stay independent", async t => {
  const { agentDir, directory } = await fixture(t);
  await writeFile(join(directory, "a.jsonl"), header("a"));
  const controller = new AbortController();
  let reads = 0;
  const cache = new NativeSessionMetadataCache(agentDir, async (path, abort) => {
    reads++;
    if (reads === 1) throw new Error("temporary read failure");
    const info = await readNativeSessionMetadata(path, abort);
    if (reads === 2) controller.abort();
    return info;
  });
  await assert.rejects(cache.list(cwd, signal()), /temporary read failure/);
  await assert.rejects(cache.list(cwd, controller.signal), { name: "AbortError" });
  assert.equal((await cache.list(cwd, signal()))[0]?.id, "a");
  assert.deepEqual(await cache.list(resolve("/other-project"), signal()), []);
  await cache.list(cwd, signal());
  assert.equal(reads, 3);
});

test("truncation and invalid records cannot leave stale metadata", async t => {
  const { agentDir, directory } = await fixture(t);
  const path = join(directory, "a.jsonl");
  const cache = new NativeSessionMetadataCache(agentDir);
  await writeFile(path, header("a") + user);
  assert.equal((await cache.list(cwd, signal()))[0]?.firstMessage, "First prompt");
  await writeFile(path, header("a") + line({ type: "message", message: "invalid" }));
  assert.equal((await cache.list(cwd, signal()))[0]?.firstMessage, "(no messages)");
  await writeFile(path, "");
  assert.deepEqual(await cache.list(cwd, signal()), []);
  await writeFile(path, line({ type: "message", id: "not a header" }));
  assert.deepEqual(await cache.list(cwd, signal()), []);
});
