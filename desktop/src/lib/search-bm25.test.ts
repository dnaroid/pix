import { describe, expect, it } from "vitest";
import { scoreBm25 } from "./search-bm25";

const doc = (title: string, metadata = "") => ({ title: title.split(" ").filter(Boolean), metadata: metadata.split(" ").filter(Boolean) });

describe("field-weighted BM25", () => {
  it("uses positive Robertson IDF and the standard saturation formula", () => {
    const scores = scoreBm25([doc("rare"), doc("common"), doc("common")], ["rare"]);
    expect(scores[0]).toBeCloseTo(3 * Math.log(1 + 2.5 / 1.5));
    expect(scores.slice(1)).toEqual([0, 0]);
  });
  it("weights rare terms above common ones", () => {
    const scores = scoreBm25([doc("rare other"), doc("common other"), doc("common other"), doc("common other")], ["rare", "common"]);
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
  });
  it("normalizes field lengths and saturates repeated terms", () => {
    const scores = scoreBm25([doc("query"), doc("query filler filler filler filler")], ["query"]);
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
    const repeated = scoreBm25([doc("query"), doc("query query query")], ["query"]);
    expect(repeated[1]!).toBeGreaterThan(repeated[0]!);
    expect(repeated[1]!).toBeLessThan(3 * repeated[0]!);
  });
  it("boosts title evidence, deduplicates query terms and handles empty fields", () => {
    const corpus = [doc("query", "filler"), doc("filler", "query"), doc("")];
    const scores = scoreBm25(corpus, ["query"]);
    expect(scores[0]!).toBeCloseTo(3 * scores[1]!);
    expect(scoreBm25(corpus, ["query", "query"])).toEqual(scores);
    expect(scoreBm25([doc("")], ["query"])).toEqual([0]);
    expect(scoreBm25([], ["query"])).toEqual([]);
    expect(scoreBm25(corpus, [])).toEqual([0, 0, 0]);
  });
});
