import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile, mkdir, mkdtemp, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SessionCandidateCatalog, nativeSessionDirectory, readSessionTitle } from "../src/project-search/session-discovery.mjs";
import { IdleSessionSelection, SessionIdlePolicy, SESSION_IDLE_MS } from "../src/project-search/session-idle.mjs";
import { transcriptUnchanged } from "../src/project-search/session-transcript.mjs";

const signal = () => new AbortController().signal;
async function fixture(t) {
  const base = fileURLToPath(new URL("../../../.pi/artifacts/session-discovery/", import.meta.url));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-")), agent = join(root, "agent");
  const directory = nativeSessionDirectory(root, agent);
  await mkdir(directory, { recursive: true });
  const policies = [];
  t.after(async () => { await Promise.all(policies.map(p => p.dispose())); await rm(root, { recursive: true, force: true }); });
  const save = async (id, rows = []) => {
    const path = join(directory, `arbitrary-name-${id}.jsonl`);
    await writeFile(path, [JSON.stringify({ type: "session", id, cwd: root, timestamp: "2020-01-01T00:00:00.000Z" }), ...rows.map(JSON.stringify)].join("\n") + "\n");
    return { id, path };
  };
  return { root, agent, directory, save, policies };
}
test("catalog reads bounded headers, never transcript bodies; warm polls read no headers", async t => {
  const f = await fixture(t), a = await f.save("a"), b = await f.save("b");
  // Invalid and very large bodies would make SDK list parse the whole corpus.
  await appendFile(a.path, "INVALID PRIVATE BODY"); await truncate(b.path, 128 * 1024 * 1024);
  // Watch delivery is injected in session-revisions tests; test header caching independently.
  const catalog = new SessionCandidateCatalog({ watching: false });
  t.after(() => catalog.dispose());
  let headers = 0;
  const header = catalog.header.bind(catalog);
  catalog.header = (...args) => { headers++; return header(...args); };
  assert.deepEqual((await catalog.list(f.root, f.agent, signal())).map(c => c.id).sort(), ["a", "b"]);
  assert.equal(headers, 2);
  await catalog.list(f.root, f.agent, signal());
  assert.equal(headers, 2, "unchanged poll reuses the identity cache");
  await appendFile(a.path, "CHANGED");
  catalog.revisions.invalidate(a.path);
  await catalog.list(f.root, f.agent, signal());
  assert.equal(headers, 3, "only a changed file gets a bounded header read");
  await assert.rejects(catalog.list(f.root, f.agent, AbortSignal.abort()));
});
test("metadata selection precedes hydration and ignores running/recent/unchanged revisions", async t => {
  const f = await fixture(t), a = await f.save("a"), b = await f.save("b"), c = await f.save("c");
  const now = Date.now(), old = new Date(now - SESSION_IDLE_MS - 1000);
  for (const candidate of [a,b]) await utimes(candidate.path, old, old);
  const policy = new SessionIdlePolicy(f.root, () => now), selection = new IdleSessionSelection(policy);
  f.policies.push(policy);
  await policy.observe(b.id, true, false);
  const catalog = new SessionCandidateCatalog({ watching: false });
  t.after(() => catalog.dispose());
  let bodyReads = 0;
  const sweep = async () => {
    for (const candidate of await selection.select(await catalog.list(f.root,f.agent,signal()),signal())) {
      bodyReads++; await readSessionTitle(f.root,candidate,signal());
    }
  };
  await sweep(); assert.equal(bodyReads, 1);
  await sweep(); assert.equal(bodyReads, 1);
  await appendFile(c.path, "recent changes");
  await sweep(); assert.equal(bodyReads, 1, "another active file does not rescan idle bodies");
});
test("title hydration authenticates native identity, names, first message and revision", async t => {
  const f = await fixture(t), a = await f.save("a", [
    { type: "message", id: "m", parentId: null, message: { role: "user", content: [{ type:"text", text:"Original prompt" }] } },
    { type: "session_info", name: "Old title" }, { type: "session_info", name: "Saved title" },
  ]);
  const title = await readSessionTitle(f.root,a,signal());
  assert.equal(title.name, "Saved title"); assert.equal(title.firstMessage, "Original prompt");
  assert.equal(await transcriptUnchanged(title,signal()),true);
  assert.equal(await readSessionTitle(f.root,{...a,id:"wrong"},signal()),undefined);
  assert.equal(await readSessionTitle(join(f.root,"wrong"),a,signal()),undefined);
  await appendFile(a.path,"\n"); assert.equal(await transcriptUnchanged(title,signal()),false);
  await assert.rejects(readSessionTitle(f.root,a,AbortSignal.abort()));
  const link = join(f.directory,"link.jsonl"); await symlink(a.path,link);
  assert.equal(await readSessionTitle(f.root,{...a,path:link},signal()),undefined);
  const catalog = new SessionCandidateCatalog({ watching: false });
  t.after(() => catalog.dispose());
  assert.equal((await catalog.list(f.root,f.agent,signal())).length,1);
});
test("title hydration ignores unrelated large payloads after first user and still sees the latest saved name", async t => {
  const f = await fixture(t);
  const a = await f.save("large", [
    { type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "First public text" }] } },
    { type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "ignored" }] } },
    { type: "session_info", name: "Last saved name" },
  ]);
  // Transcript validation owns malformed/tool-only bodies, not title discovery.
  await appendFile(a.path, "NOT JSON BUT NOT TITLE METADATA\n");
  await appendFile(a.path, JSON.stringify({ type: "message", id: "large", message: {
    role: "assistant", content: [{ type: "toolResult", text: "x".repeat(2 * 1024 * 1024) }],
  } }) + "\n" + JSON.stringify({ type: "session_info", name: "Newest name" }) + "\n");
  const title = await readSessionTitle(f.root, a, signal());
  assert.equal(title?.name, "Newest name");
  assert.equal(title?.firstMessage, "First public text");
});
