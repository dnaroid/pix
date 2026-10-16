import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { excludeSessionAttachments } from "../src/search/session-text.js";
import { parseSessionRecord } from "../src/search/session-record.js";
import { readSessionTranscript, sessionContext } from "../src/search/session-transcript.js";
import { indexSessionChunks, searchSessionChunks } from "../src/search/session-chunks.js";
import { collectRagEvidence } from "../src/search/rag-evidence.js";
import { enableSearchSources } from "./search-sources-fixture.js";

const signal = () => new AbortController().signal;
const message = (id: string, parentId: string | null, role: string, text: string) =>
  ({ type: "message", id, parentId, message: { role, content: text, stopReason: "stop" } });

test("sandbox projection preserves prose, ordinary code, fence examples and inline mentions", () => {
  const cases = [
    ["before\n```pix-html\nsecret\n```\nafter", "before\nafter"],
    ["a\r\n  ~~~~PIX-HTML title\r\nsecret\r\n~~~~~\r\nb", "a\r\nb"],
    ["```html-sandbox\nsecret\n```\nprose\n```pix-html\nsecond\n```", "prose\n"],
    ["```pix-html\nunfinished secret", ""],
    ["```pix-html\nsecret\n~~~\nstill secret", ""],
    ["````pix-html\n```\nstill secret\n````\nend", "end"],
    ["```js\nconst a = 1;\n```", "```js\nconst a = 1;\n```"],
    ["````markdown\n```pix-html\nexample\n```\n````", "````markdown\n```pix-html\nexample\n```\n````"],
    ["Use `pix-html` for games.", "Use `pix-html` for games."],
    ["```pix-html-other\nordinary\n```", "```pix-html-other\nordinary\n```"],
  ];
  for (const [input, expected] of cases) assert.equal(excludeSessionAttachments(input!), expected);
});

test("both record paths exclude sandbox text before the public-text limit", async () => {
  for (const role of ["user", "assistant"]) {
    for (const size of [30, 1100000]) {
      const raw = JSON.stringify(message("a", null, role, `before\n\`\`\`pix-html\n${"x".repeat(size)}\n\`\`\`\nafter`));
      const parsed = await parseSessionRecord(raw, signal());
      assert.equal(parsed.entry?.message?.text, "before\nafter");
      assert.equal(parsed.reason, undefined);
    }
  }
  const split = { ...message("a", null, "assistant", ""), message: { role: "assistant", content: [
    { type: "text", text: "before\n```pix-html\nsecret" },
    { type: "image", data: "ignored" }, { type: "text", text: "more secret\n```\nafter" },
  ] } };
  assert.equal((await parseSessionRecord(JSON.stringify(split), signal())).entry?.message?.text, "before\nafter");
  assert.equal((await parseSessionRecord(JSON.stringify(message("a", null, "user", "x".repeat(1100000))), signal())).reason,
    "public_text_exceeds_limit");
});

test("index refresh replaces old sandbox chunks; embedding, retrieval and RAG use only projected text", async () => {
  const base = resolve(".pi/artifacts/session-attachments-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  let db: DatabaseSync | undefined;
  try {
    await enableSearchSources(root);
    const candidate = { id: "native", path: join(root, "session.jsonl") };
    const raw = [
      { type: "session", id: candidate.id, cwd: root },
      message("u", null, "user", "Build Doom"),
      message("a", "u", "assistant", `Ready\n\`\`\`pix-html\n${"SECRETcode ".repeat(7000)}\n\`\`\`\nUse arrows`),
      message("only", "a", "assistant", "```pix-html\nONLYcode\n```"),
      message("last", "only", "user", "Keep the game"),
    ].map(row => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(candidate.path, raw);
    await indexSessionChunks(root, [candidate], { signal: signal() });
    db = new DatabaseSync(join(root, ".pi/search/sessions.sqlite"));
    // Recreate a pre-projection cache with the same unchanged canonical file.
    const oldRevision = createHash("sha256").update(raw).digest("hex");
    db.prepare("UPDATE pix_session_chunk_meta SET revision=?").run(oldRevision);
    // reconcile() trusts the indexed-files record; mark that pre-projection revision stale too.
    db.prepare("UPDATE pix_session_indexed_files SET revision=?").run(oldRevision);
    db.exec("UPDATE pix_session_chunks SET text='SECRETcode',hash='old'; UPDATE pix_session_chunk_fts SET text='SECRETcode'");
    const vector = Buffer.alloc(8); vector.writeFloatLE(1, 0);
    db.prepare("INSERT INTO pix_session_chunk_vectors VALUES(?,?,?)").run("session-chunks-v1:mock", "old", vector);
    const uploaded: string[] = [];
    const indexed = await indexSessionChunks(root, [candidate], { signal: signal(), embedding: {
      identity: "mock", dimension: 2, authorized: async () => true,
      embed: async texts => { uploaded.push(...texts); return texts.map(() => [1, 0]); },
    } });
    assert.equal(indexed.complete, true);
    assert.equal(uploaded.length, 3);
    assert.doesNotMatch(uploaded.join("\n"), /SECRETcode|ONLYcode|pix-html/);
    for (const table of ["pix_session_chunks", "pix_session_chunk_fts"]) {
      assert.doesNotMatch(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()), /SECRETcode|ONLYcode/);
    }
    assert.deepEqual(await searchSessionChunks(root, [candidate], "SECRETcode", signal()), []);
    const hits = await searchSessionChunks(root, [candidate], "arrows", signal(), { identity: "mock", dimension: 2, query: [1, 0] });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.messageId, "a"); // An exact lexical hit keeps a tie against equal semantic scores.
    assert.equal((await searchSessionChunks(root, [candidate], "arrows", signal()))[0]?.messageId, "a");
    const snapshot = (await readSessionTranscript(root, candidate, signal()))!;
    assert.deepEqual(snapshot.messages.map(m => m.id), ["u", "a", "last"]);
    assert.doesNotMatch(sessionContext(snapshot, "a")!, /INCOMPLETE|SECRETcode|ONLYcode/);
    const evidence = await collectRagEvidence({ cwd: root, query: "Doom", requestId: "r", sources: [
      { id: "sessions:native", kind: "sessions", sessionId: "native", messageId: "a", title: "Doom", snippet: "SECRETcode" },
    ] }, signal(), async () => candidate);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.incomplete, undefined);
    assert.match(evidence[0]!.text, /Keep the game/);
    assert.doesNotMatch(evidence[0]!.text, /SECRETcode|ONLYcode/);
    assert.equal(await readFile(candidate.path, "utf8"), raw);
  } finally {
    // Close our SQLite connection before cleaning the fixture; on Windows,
    // the filesystem may briefly retain its native handles after close.
    try { db?.close(); }
    finally { await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); }
  }
});
