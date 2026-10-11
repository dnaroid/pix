import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadSemanticEmbeddingConfig, semanticSearchConfigPath, SearchPreferences, sharedSearchAuth } from "../src/search/config.js";
import { loadCommitEmbeddingConfig, loadCommitEmbeddingKey } from "../src/search/commit-provider.js";
import { parseSearchConfigRequest } from "../src/search/request.js";

const embedding = { embeddingProvider: "ollama", embeddingModel: "code-model", vectorSize: 4,
  knowledgeEmbeddingModel: "knowledge-model", knowledgeEmbeddingQueryPrefix: "query:", knowledgeEmbeddingDocumentPrefix: "doc:", ollamaBaseUrl: "http://localhost:11434" };
async function fixture(t: TestContext) {
  const artifacts = resolve(".pi/artifacts/central-semantics-acp/preferences-fixtures");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, ".config/pi/pi-tools-suite.jsonc");
  await mkdir(dirname(path), { recursive: true });
  return { root, path, preferences: new SearchPreferences(path) };
}

test("valid central configuration itself enables every semantic source without consent flags", async t => {
  const f = await fixture(t);
  assert.equal(await f.preferences.enabled(), false);
  const source = JSON.stringify({ enabled: false, search: { embedding, semanticEnabled: false, sessionTitlesEnabled: false, tasksSemanticEnabled: false } });
  await writeFile(f.path, source);
  assert.equal(await f.preferences.enabled(), true);
  assert.equal(await f.preferences.sessionTitlesEnabled(), true);
  assert.equal(await f.preferences.tasksSemanticEnabled(), true);
  assert.deepEqual(await f.preferences.embedding(), { provider: "ollama", model: "knowledge-model", dimension: 4, queryPrefix: "query:", documentPrefix: "doc:", baseUrl: "http://localhost:11434" });
  assert.equal(await readFile(f.path, "utf8"), source, "ACP is read-only");
  await rm(f.path);
  assert.equal(await f.preferences.tasksSemanticEnabled(), false);
});

test("malformed, absent, obsolete and invalid central settings fail closed without repair", async t => {
  const f = await fixture(t);
  const invalid = ["{", "[]", "null", '{// jsonc\n"embedding":{}}', JSON.stringify({ embedding }), JSON.stringify({ search: { semanticEnabled: true } }),
    ...[{ embeddingProvider: "idx" }, { embeddingModel: "" }, { knowledgeEmbeddingModel: "" }, { vectorSize: 0 }, { vectorSize: 8193 },
      { vectorSize: 1.5 }, { knowledgeEmbeddingQueryPrefix: 42 }, { knowledgeEmbeddingDocumentPrefix: "x".repeat(513) },
      { ollamaBaseUrl: "file:///tmp" }, { ollamaBaseUrl: "http://user:secret@localhost" }, { ollamaBaseUrl: "http://localhost?key=secret" }]
      .map(change => JSON.stringify({ search: { embedding: { ...embedding, ...change } } })), " ".repeat(8193)];
  for (const source of invalid) {
    await writeFile(f.path, source);
    assert.equal(await f.preferences.embedding(), undefined);
    assert.equal(await f.preferences.enabled(), false);
    assert.equal(await readFile(f.path, "utf8"), source);
  }
});

test("central file rejects symlinks, linked ancestors and hardlinks", async t => {
  const f = await fixture(t);
  const real = join(f.root, "real.json");
  await writeFile(real, JSON.stringify({ search: { embedding } }));
  await symlink(real, f.path);
  assert.equal(await loadSemanticEmbeddingConfig(f.path), undefined);
  await rm(f.path); await link(real, f.path);
  assert.equal(await loadSemanticEmbeddingConfig(f.path), undefined);
  await rm(f.path); await rm(real);
  await rm(dirname(f.path), { recursive: true }); await mkdir(join(f.root, "elsewhere"));
  await symlink(join(f.root, "elsewhere"), dirname(f.path), "dir");
  await writeFile(f.path, JSON.stringify({ search: { embedding } }));
  assert.equal(await loadSemanticEmbeddingConfig(f.path), undefined);
});

test("HOME central path is shared by commits and history; legacy project and Desktop flags do not authorize", async t => {
  const f = await fixture(t); const previous = process.env.HOME;
  process.env.HOME = f.root;
  t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  assert.equal(semanticSearchConfigPath(), f.path);
  await writeFile(join(dirname(f.path), "pix-desktop.jsonc"), JSON.stringify({ search: { semanticEnabled: true } }));
  await mkdir(join(f.root, ".pi/search"), { recursive: true });
  await writeFile(join(f.root, ".pi/search/semantic.json"), JSON.stringify({ enabled: true, embedding }));
  assert.equal(await loadCommitEmbeddingConfig(f.root), undefined);
  await writeFile(f.path, JSON.stringify({ search: { embedding } }));
  assert.ok(await f.preferences.embedding(), "canonical global suite configuration is authorized");
  assert.deepEqual(await loadCommitEmbeddingConfig("/unrelated/project"), await f.preferences.embedding());
});

test("obsolete ACP writes are rejected, including false and credential-removal values", async () => {
  assert.deepEqual(parseSearchConfigRequest({ cwd: "/project" }), { cwd: "/project" });
  for (const field of ["enabled", "sessionTitlesEnabled", "tasksSemanticEnabled", "messageFilterEnabled", "apiKey", "embedding"])
    for (const value of [true, false, "", undefined]) assert.throws(() => parseSearchConfigRequest({ cwd: "/project", [field]: value }));
});

test("environment credential takes precedence over shared SDK auth and commits use the same fallback", async t => {
  const f = await fixture(t);
  const agent = join(f.root, "agent"); await mkdir(agent);
  await writeFile(join(agent, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "stored-only" } }));
  assert.equal(await sharedSearchAuth(agent, {}).key(new AbortController().signal), "stored-only");
  assert.equal(await sharedSearchAuth(agent, { OPENROUTER_API_KEY: " env-only " }).key(new AbortController().signal), "env-only");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  assert.equal(await loadCommitEmbeddingKey({}), "stored-only");
  assert.equal(await loadCommitEmbeddingKey({ OPENROUTER_API_KEY: " env-only " }), "env-only");
});

test("shared credential reads reject linked, oversized and malformed storage without repair", async t => {
  const f = await fixture(t);
  const agent = join(f.root, "agent"); await mkdir(agent);
  const path = join(agent, "auth.json");
  for (const value of ["{", " ".repeat(512 * 1024 + 1), JSON.stringify({ openrouter: { type: "oauth", key: "not-static" } })]) {
    await writeFile(path, value);
    assert.equal(await sharedSearchAuth(agent, {}).key(new AbortController().signal), undefined);
    assert.equal(await readFile(path, "utf8"), value);
  }
  await rm(path);
  const target = join(f.root, "credentials.json");
  await writeFile(target, JSON.stringify({ openrouter: { type: "api_key", key: "linked" } }));
  await symlink(target, path);
  assert.equal(await sharedSearchAuth(agent, {}).key(new AbortController().signal), undefined);
});
