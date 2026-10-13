import { describe, expect, test } from "bun:test";
import { preferDistinctFiles, queryTerms, queryIdentifiers } from "../src/project-search/native-ranking.mjs";
import { selectFederatedCandidates } from "../src/project-search/federation-ranking.mjs";
import { rerankerDocuments, MAX_RERANK_INPUT_BYTES } from "../src/project-search/reranker-documents.mjs";

describe("query evidence and bounded rerank inputs", () => {
  test("natural-language glue does not dominate English or Russian lexical retrieval", () => {
    expect(queryTerms("How does settingsFingerprint hash the files?")).toEqual(["settings", "fingerprint", "hash", "files"]);
    expect(queryTerms("Что и как искать в файлах для кода или документации?")).toEqual(["искать", "файлах", "кода", "документации"]);
    expect(queryIdentifiers("Where is requestNative or APIClient configured?")).toEqual(["requestNative", "APIClient"]);
  });
  test("distinct files get candidate space even when a document has many chunks", () => {
    const hits = Array.from({length: 100}, (_, i) => ({kind:"knowledge",id:`a${i}`,path:"a.md"}));
    hits.push({kind:"knowledge",id:"b",path:"b.md"}, {kind:"code",id:"c",path:"c.ts"});
    expect(preferDistinctFiles(hits).slice(0,3).map(hit=>hit.id)).toEqual(["a0","b","c"]);
    const candidates = selectFederatedCandidates(hits);
    expect(candidates).toContain(hits[100]);
    expect(candidates).toContain(hits[101]);
    expect(candidates.length).toBe(100);
  });
  test("the entire multilingual batch is UTF-8 bounded and focuses late identifiers", () => {
    const hits = Array.from({length:100}, (_, i) => ({path:`src/${i}.ts`,title:`src/${i}.ts`,
      content:`${"无关текст ".repeat(1000)}export function settingsFingerprint() { return hash; }`, snippet:"unused"}));
    const docs = rerankerDocuments("Where is settingsFingerprint defined?", hits);
    expect(docs.length).toBe(100);
    expect(docs.every(doc=>doc.includes("settingsFingerprint") && !doc.includes("�"))).toBe(true);
    expect(docs.reduce((sum,doc)=>sum+Buffer.byteLength(doc),Buffer.byteLength("Where is settingsFingerprint defined?"))).toBeLessThanOrEqual(MAX_RERANK_INPUT_BYTES);
  });
});
