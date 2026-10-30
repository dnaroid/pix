import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_ARTIFACTS_DIR } from "../external/pi-tools-suite/src/artifact-paths.js";
import type { KnowledgeSnapshot } from "../acp/src/knowledge/evidence.js";
import { knowledgeEvalCases } from "../scripts/knowledge-check-eval/cases.js";
import { materializeRetrievalFixture, scoreKnowledgeRetrieval, type KnowledgeRetrievalCall } from "../scripts/knowledge-check-eval/retrieval.js";

const sample = knowledgeEvalCases.find(item => item.id === "exact-number")!;
const source = sample.evidence[0]!;
const completeCall: KnowledgeRetrievalCall = { query: "fixture query", elapsedMs: 1,
  hits: [{ path: source.path, startLine: 7, endLine: 9 }], notices: [],
  status: { complete: true, stale: false, semanticEnabled: true,
    semantic: { enabled: true, complete: true, state: "ready" } } };
function snapshot(extra: Partial<KnowledgeSnapshot> = {}): KnowledgeSnapshot {
  return { document: sample.document, evidence: [source], documentHash: "fixture", wikiPath: "wiki",
    notices: [], complete: true, current: async () => true, candidatePaths: [source.path], ...extra };
}

describe("native contradiction retrieval scoring", () => {
  it("requires the expected source and decisive original claim in a complete hybrid selection", () => {
    const result = scoreKnowledgeRetrieval(sample, snapshot(), [completeCall], true);
    assert.equal(result.passed, true);
    assert.equal(result.expectedSources, 1);
    assert.equal(result.candidateSourcesMatched, 1);
    assert.equal(result.selectedSourcesMatched, 1);
    assert.equal(result.decisiveClaimsMatched, 1);
  });

  it("does not confuse a candidate path or an unrelated excerpt with a retrieved proof", () => {
    const notSelected = scoreKnowledgeRetrieval(sample, snapshot({ evidence: [] }), [completeCall], true);
    assert.equal(notSelected.candidateSourcesMatched, 1);
    assert.equal(notSelected.selectedSourcesMatched, 0);
    assert.equal(notSelected.passed, false);
    const wrongExcerpt = scoreKnowledgeRetrieval(sample, snapshot({ evidence: [{ ...source, text: "# Classic v2\nСодержание раздела." }] }), [completeCall], true);
    assert.equal(wrongExcerpt.selectedSourcesMatched, 1);
    assert.equal(wrongExcerpt.decisiveClaimsMatched, 0);
    assert.equal(wrongExcerpt.passed, false);
  });

  it("never upgrades lexical-only or unfinished semantic search to a passing hybrid result", () => {
    const lexical = { ...completeCall, status: { complete: true, stale: false, semanticEnabled: false } };
    assert.equal(scoreKnowledgeRetrieval(sample, snapshot(), [lexical], true).passed, false);
    const pending = { ...completeCall, status: { ...completeCall.status!, semantic: { enabled: true, complete: false, state: "indexing" } } };
    assert.equal(scoreKnowledgeRetrieval(sample, snapshot(), [pending], true).passed, false);
    assert.equal(scoreKnowledgeRetrieval(sample, snapshot(), [], true).passed, false);
  });

  it("keeps stale, failed and partial retrievals incomplete even with a matching passage", () => {
    assert.equal(scoreKnowledgeRetrieval(sample, snapshot({ complete: false }), [completeCall], true).passed, false);
    assert.equal(scoreKnowledgeRetrieval(sample, snapshot(), [completeCall], false).passed, false);
    const stale = { ...completeCall, status: { ...completeCall.status!, stale: true } };
    assert.equal(scoreKnowledgeRetrieval(sample, snapshot(), [stale], true).selectionComplete, false);
    const failed = { query: "failed", elapsedMs: 1, hits: [], notices: [], error: "Native worker failed" };
    assert.equal(scoreKnowledgeRetrieval(sample, undefined, [failed], false).passed, false);
  });

  it("checks source content for negative controls and retains deciding lifecycle context", () => {
    const clear = knowledgeEvalCases.find(item => item.id === "explicit-supersession")!;
    const proof = clear.evidence[0]!;
    const correct = snapshot({ document: clear.document, evidence: [proof], candidatePaths: [proof.path] });
    assert.equal(scoreKnowledgeRetrieval(clear, correct, [completeCall], true).passed, true);
    const { context: _context, ...withoutContext } = proof;
    assert.equal(scoreKnowledgeRetrieval(clear, { ...correct, evidence: [withoutContext] }, [completeCall], true).passed, false);
  });
});

describe("owned native retrieval fixtures", () => {
  async function output(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const artifacts = join(root, PROJECT_ARTIFACTS_DIR);
    await mkdir(artifacts, { recursive: true });
    const directory = await mkdtemp(join(artifacts, "knowledge-retrieval-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
  }

  it("creates a fresh isolated Git root with original text, line padding and local source policy", async t => {
    const directory = await output(t);
    const signal = new AbortController().signal;
    const first = await materializeRetrievalFixture(sample, directory, signal);
    const second = await materializeRetrievalFixture(sample, directory, signal);
    assert.notEqual(first, second);
    assert.equal(await realpath(first), first);
    assert.equal(await readFile(join(first, sample.document.path), "utf8"), sample.document.text);
    assert.equal(await readFile(join(first, source.path), "utf8"), "\n".repeat(source.startLine - 1) + source.text);
    const config = JSON.parse(await readFile(join(first, ".pi/workspace.jsonc"), "utf8"));
    assert.equal(config.search.sources.knowledge, true);
    assert.equal(config.search.sources.code, false);
    assert.ok((await readdir(first)).includes(".git"));
    assert.equal((await readdir(join(first, "wiki/retrieval-decoys"))).length, 4);
  });

  it("rejects unsafe paths and pre-aborted work before allocating fixture files", async t => {
    const directory = await output(t);
    await assert.rejects(materializeRetrievalFixture({ ...sample, document: { ...sample.document, path: "wiki/../../outside.md" } }, directory, new AbortController().signal), /unsafe/u);
    const controller = new AbortController();
    controller.abort(new Error("Eval cancelled"));
    await assert.rejects(materializeRetrievalFixture(sample, directory, controller.signal), /Eval cancelled/u);
    assert.deepEqual(await readdir(directory), []);
  });
});
