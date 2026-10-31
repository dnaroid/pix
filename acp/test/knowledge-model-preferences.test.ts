import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadKnowledgeModelPreferences } from "../src/knowledge/model-preferences.js";
import { KnowledgeReportError } from "../src/knowledge/report-language.js";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pix-knowledge-model-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { desktopPath: join(root, "desktop.jsonc"), suitePath: join(root, "suite.jsonc") };
  const write = (target: "desktopPath" | "suitePath", knowledgeCheck: unknown, extra = {}) =>
    writeFile(paths[target], JSON.stringify({ ...extra, knowledgeCheck }));
  return { root, paths, write, load: () => loadKnowledgeModelPreferences(root, paths) };
}
const reason = (expected: string) => (error: unknown) => error instanceof KnowledgeReportError && error.reason === expected;

describe("independent Wiki contradiction judge preferences", () => {
  it("requires a judge instead of silently using RAG or session defaults", async t => {
    const { write, load } = await setup(t);
    await assert.rejects(load(), reason("selectModel"));
    await write("desktopPath", {}, { search: { ragModelRef: "search/model", ragThinking: "high" },
      defaultModel: { modelRef: "session/model", thinking: "max" } });
    await assert.rejects(load(), reason("selectModel"));
  });
  it("inherits the Suite judge and low reasoning when Desktop is absent", async t => {
    const { write, load } = await setup(t);
    await write("suitePath", { modelRef: "suite/judge" });
    assert.deepEqual(await load(), { modelRef: "suite/judge", thinking: "low" });
  });
  it("overrides fields independently; blank Desktop values inherit Suite", async t => {
    const { write, load } = await setup(t);
    await write("suitePath", { modelRef: "suite/judge", thinking: "high" });
    for (const desktop of [{}, { modelRef: "", thinking: "" }, { modelRef: "  ", thinking: " " }]) {
      await write("desktopPath", desktop);
      assert.deepEqual(await load(), { modelRef: "suite/judge", thinking: "high" });
    }
    await write("desktopPath", { modelRef: "desktop/judge" });
    assert.deepEqual(await load(), { modelRef: "desktop/judge", thinking: "high" });
    await write("desktopPath", { thinking: "off" });
    assert.deepEqual(await load(), { modelRef: "suite/judge", thinking: "off" });
  });
  it("does not consult an unused invalid Suite file when Desktop sets both values", async t => {
    const { paths, write, load } = await setup(t);
    await writeFile(paths.suitePath, "invalid JSON");
    await write("desktopPath", { modelRef: "desktop/judge", thinking: "max" });
    assert.deepEqual(await load(), { modelRef: "desktop/judge", thinking: "max" });
  });
  it("accepts all reasoning levels, including off and max, without RAG coupling", async t => {
    const { write, load } = await setup(t);
    for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      await write("desktopPath", { modelRef: "provider/judge", thinking }, { search: { ragThinking: "other" } });
      assert.equal((await load()).thinking, thinking);
    }
  });
  it("supports nested model identifiers, trims the reference and defaults blank reasoning to low", async t => {
    const { write, load } = await setup(t);
    await write("suitePath", { modelRef: " openrouter/vendor/judge ", thinking: "" });
    assert.deepEqual(await load(), { modelRef: "openrouter/vendor/judge", thinking: "low" });
  });
  it("rejects malformed explicit model settings instead of falling back to Suite", async t => {
    const { write, load } = await setup(t);
    await write("suitePath", { modelRef: "suite/judge", thinking: "low" });
    for (const modelRef of [null, 12, [], {}, "noslash", "/judge", "provider/", "provider/a b", "provider/model:high", "x/" + "m".repeat(255)]) {
      await write("desktopPath", { modelRef });
      await assert.rejects(load(), reason("judgeConfigInvalid"));
    }
  });
  it("rejects invalid reasoning or config shape without silently using another budget", async t => {
    const { write, load, paths } = await setup(t);
    await write("suitePath", { modelRef: "suite/judge", thinking: "low" });
    for (const thinking of [null, 1, {}, [], "ultra", "HIGH"]) {
      await write("desktopPath", { modelRef: "desktop/judge", thinking });
      await assert.rejects(load(), reason("judgeConfigInvalid"));
    }
    for (const text of ["broken", "[]", "null", '{"knowledgeCheck":[]}', '{"knowledgeCheck":null}']) {
      await writeFile(paths.desktopPath, text);
      await assert.rejects(load(), reason("judgeConfigInvalid"));
    }
  });
  it("does not read project overrides and never modifies configuration", async t => {
    const { root, paths, write, load } = await setup(t);
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", "pix-desktop.jsonc"), '{"knowledgeCheck":{"modelRef":"untrusted/judge","thinking":"max"}}');
    await write("suitePath", { modelRef: "suite/judge" });
    const before = await readFile(paths.suitePath, "utf8");
    assert.equal((await load()).modelRef, "suite/judge");
    assert.equal(await readFile(paths.suitePath, "utf8"), before);
    await assert.rejects(readFile(paths.desktopPath), { code: "ENOENT" });
  });
  it("reloads edited JSONC settings for the next check and preserves comments", async t => {
    const { paths, write, load } = await setup(t);
    const initial = '{ // keep\n "knowledgeCheck":{"modelRef":"suite/first","thinking":"low",},}';
    await writeFile(paths.suitePath, initial);
    assert.equal((await load()).modelRef, "suite/first");
    assert.equal(await readFile(paths.suitePath, "utf8"), initial);
    await write("suitePath", { modelRef: "suite/second", thinking: "high" });
    assert.deepEqual(await load(), { modelRef: "suite/second", thinking: "high" });
  });
  it("wires the production service to the dedicated loader rather than the RAG loader", async t => {
    const { root } = await setup(t);
    const config = join(root, ".config", "pi");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "pix-desktop.jsonc"), JSON.stringify({
      search: { ragModelRef: "search/not-the-judge", ragThinking: "low" },
      defaultModel: { modelRef: "session/not-the-judge", thinking: "off" },
      knowledgeCheck: { reportLanguage: "ru" },
    }));
    await writeFile(join(config, "pi-tools-suite.jsonc"), JSON.stringify({
      knowledgeCheck: { modelRef: "dedicated/judge", thinking: "high" },
    }));
    // A child owns the isolated HOME; no mutable process environment leaks to other tests.
    const script = `
      import assert from 'node:assert/strict';
      import { KnowledgeCheckService } from ${JSON.stringify(new URL("../src/knowledge/service.ts", import.meta.url).href)};
      let calls = 0;
      const checker = new KnowledgeCheckService({
        search: async () => { throw new Error('Unexpected search'); },
        collect: async request => ({ document: { path: request.path, text: request.content },
          documentHash: 'a'.repeat(64), wikiPath: 'wiki', complete: true, notices: [],
          evidence: [{ id: 'one', path: 'wiki/source.md', text: 'Reference text.', startLine: 1 }],
          current: async () => true }),
        createRuntime: async () => ({ dispose() {}, modelRuntime: {
          getModel(provider, id) {
            assert.equal(provider, 'dedicated'); assert.equal(id, 'judge');
            return { provider, id, reasoning: true, maxTokens: 8192 };
          },
          async completeSimple(model, context, options) {
            calls++; assert.equal(options.reasoning, 'high');
            assert.match(context.systemPrompt, /Russian/u);
            return { stopReason: 'stop', content: [{ type: 'text', text: '{"conflicts":[],"uncertainties":[]}' }] };
          }
        } })
      });
      const result = await checker.check({ cwd: ${JSON.stringify(root)}, path: 'wiki/page.md', content: 'Original text.' }, new AbortController().signal);
      assert.equal(result.status, 'clear'); assert.equal(result.modelRef, 'dedicated/judge');
      assert.equal(result.reportLanguage, 'ru'); assert.equal(calls, 1);
    `;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, HOME: root, USERPROFILE: root, PI_OFFLINE: "1" },
      timeout: 30_000, maxBuffer: 128 * 1024,
    });
  });
});
