import { describe, expect, test } from "bun:test";
import { bytePrefix, contiguousPassage, selectPassage } from "../src/project-search/reranker-passages.mjs";
import { MAX_RERANK_INPUT_BYTES, rerankerDocuments } from "../src/project-search/reranker-documents.mjs";
import { documentLifecycle } from "../src/project-search/reranker-lifecycle.mjs";

describe("bounded reranker evidence", () => {
  test("code packing keeps contiguous syntax and verified lifecycle stays knowledge-only", () => {
    const content = "export function settingsDocuments() {\n  return records.map(item => ({\n    text: item.description + item.synonyms.join(' '),\n  }));\n}\n";
    const hits = [{kind: "code", path: "a.ts", title: "a.ts", content},
      {kind: "knowledge", path: "a.md", title: "Detail", content: "Evidence."}];
    const documents = rerankerDocuments("settingsDocuments", hits, new Map([["a.ts", "superseded"], ["a.md", "superseded"]]));
    expect(documents[0]).toBe(`a.ts\n${content}`);
    expect(documents[1]).toStartWith("Document status: superseded\na.md\nDetail\n");
  });
  test("lifecycle parsing never infers status from path, prose or body examples", () => {
    expect(documentLifecycle("# Decision\n- Status: superseded\n\n## Detail")).toBe("superseded");
    expect(documentLifecycle("# Decision\n**Status**: accepted — reviewed")).toBe("accepted");
    expect(documentLifecycle("# Guide\n## Examples\nStatus: obsolete")).toBeUndefined();
    expect(documentLifecycle("# Guide\nThis superseded decision is discussed.\n```\nStatus: archived\n```")).toBeUndefined();
    expect(documentLifecycle("# Guide\n````md\n```\nStatus: archived\n```\n````")).toBeUndefined();
    expect(documentLifecycle("# Guide\n~~~md\n```\nStatus: archived\n```\n~~~")).toBeUndefined();
    expect(documentLifecycle("# Guide\n```md\nStatus: obsolete\n```\nStatus: active")).toBe("active");
    expect(documentLifecycle("# Guide\n" + "\n".repeat(33) + "Status: archived")).toBeUndefined();
  });
  test("empty input and short passages stay unchanged", () => {
    expect(rerankerDocuments("question", [])).toEqual([]);
    expect(selectPassage("question", "A short complete passage.", 100)).toBe("A short complete passage.");
    expect(bytePrefix("пример 🧭", 0)).toBe("");
  });

  test("UTF-8 prefixes never split a code point", () => {
    const text = "абв 🧭 delta";
    for (let bytes = 0; bytes <= Buffer.byteLength(text); bytes++) {
      const result = bytePrefix(text, bytes);
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(bytes);
      expect(text.startsWith(result)).toBe(true);
      expect(result).not.toContain("�");
    }
    const textWithAnchor = "🧭" + "x".repeat(47) + "policyFingerprint changes";
    const result = contiguousPassage("policyFingerprint", textWithAnchor, 100);
    expect(result).toStartWith("🧭");
    expect(result).not.toContain("�");
  });

  test("a deep identifier outranks an introductory incidental word", () => {
    const text = "The service provides generic configuration. ".repeat(30)
      + "The policyFingerprint changes when the active source policy changes. "
      + "Other implementation details follow. ".repeat(30);
    const result = selectPassage("service policyFingerprint", text, 150);
    expect(result).toContain("policyFingerprint changes");
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(150);
  });

  test("an oversized line is windowed around its identifier", () => {
    const text = "unrelated ".repeat(100) + "policyFingerprint controls publication " + "unrelated ".repeat(100);
    expect(selectPassage("policyFingerprint", text, 120)).toContain("policyFingerprint");
  });

  test("literal prose retains the established contiguous window", () => {
    const text = "Introduction. ".repeat(30) + "HTTP 429 alone does not prove an exhausted provider quota. "
      + "A corroborating marker is required before quota enforcement. ".repeat(10);
    expect(selectPassage("Does HTTP 429 automatically trigger quota waiting?", text, 200))
      .toBe(contiguousPassage("Does HTTP 429 automatically trigger quota waiting?", text, 200));
  });

  test("explicit acronyms retain the established contiguous window", () => {
    const text = "The editor has independent views. ".repeat(20)
      + "RPC requests use their own cancellation owner. " + "Other views have independent state. ".repeat(20);
    const query = "Which editor view owns RPC cancellation?";
    expect(selectPassage(query, text, 200)).toBe(contiguousPassage(query, text, 200));
  });

  test("ordinary prose covers the question beyond its first incidental term", () => {
    const text = "The service supports configuration and its generic defaults. ".repeat(20)
      + "The request owner cancels execution before publishing during teardown. "
      + "The service has additional configuration options. ".repeat(20);
    expect(selectPassage("Which service owner cancels execution before publishing during teardown?", text, 180))
      .toContain("The request owner cancels execution before publishing during teardown.");
  });

  test("cross-language extraction preserves an accounting exclusion below the introduction", () => {
    const text = [
      "The statistics reducer belongs to the report service and shared formatter.",
      "Opening statistics never prunes history or calls a model.",
      "The report records measured token deltas for completed operations.",
      "Measured token deltas accumulate across recorded report operations.",
      "A sum of measured deltas is not current context savings or saved billing.",
      "Failed attempts may count as attempts, never as successful completion.",
    ].join("\n\n");
    const result = selectPassage("Почему статистика не означает экономию денег или размер контекста?", text, 235);
    expect(result).toContain("A sum of measured deltas is not current context savings or saved billing.");
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(235);
  });

  test("the query and entire candidate pool share the byte budget without duplicate headers", () => {
    const query = "Где проверяется policyFingerprint?";
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      path: `src/${index}.ts`, title: `src/${index}.ts`,
      content: "начало ".repeat(200) + "policyFingerprint verifies the active policy. " + "конец ".repeat(200),
    }));
    const documents = rerankerDocuments(query, candidates);
    expect(documents).toHaveLength(100);
    expect(Buffer.byteLength(query) + documents.reduce((sum, text) => sum + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(MAX_RERANK_INPUT_BYTES);
    documents.forEach((text, index) => {
      expect(text.startsWith(`src/${index}.ts\n`)).toBe(true);
      expect(text.split(`src/${index}.ts`)).toHaveLength(2);
      expect(text).not.toContain("�");
    });
    expect(Buffer.byteLength(rerankerDocuments(query, [candidates[0]])[0])).toBeLessThanOrEqual(8192);
    expect(rerankerDocuments("x".repeat(MAX_RERANK_INPUT_BYTES), candidates)).toEqual(candidates.map(() => ""));
  });
});
