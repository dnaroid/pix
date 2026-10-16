import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fuzzySearch } from "./fuzzy";
import { modelsBySelectionFrequency, readModelSelectionCounts, recordModelSelection } from "./model-selection-frequency";

const report = vi.hoisted(() => vi.fn());
vi.mock("./diagnostic-logging", () => ({ createDiagnosticLogger: () => ({ report }) }));

describe("project model selection frequency", () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    report.mockClear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("persists independent counts per project and provider/model reference", () => {
    recordModelSelection("/one", "a/model");
    recordModelSelection("/one", "a/model");
    recordModelSelection("/one", "b/model");
    recordModelSelection("/two", "b/model");
    expect(readModelSelectionCounts("/one")).toEqual({ "a/model": 2, "b/model": 1 });
    expect(readModelSelectionCounts("/two")).toEqual({ "b/model": 1 });
    expect(readModelSelectionCounts("/new")).toEqual({});
    recordModelSelection("", "a/model");
    expect(storage.size).toBe(2);
  });

  it("sorts descending without mutating the catalog and preserves ties", () => {
    const models = Object.freeze([{ ref: "a" }, { ref: "b" }, { ref: "c" }, { ref: "d" }]);
    expect(modelsBySelectionFrequency(models, { b: 2, c: 2 }).map((model) => model.ref))
      .toEqual(["b", "c", "a", "d"]);
    expect(models.map((model) => model.ref)).toEqual(["a", "b", "c", "d"]);
    expect(modelsBySelectionFrequency(models, {})).toEqual(models);
  });

  it("preserves fuzzy relevance ahead of usage while using frequency for equal matches", () => {
    const models = modelsBySelectionFrequency([{ ref: "gpt" }, { ref: "gpt-long" }], { "gpt-long": 10 });
    const items = models.map((model) => ({ label: model.ref, value: model.ref }));
    expect(fuzzySearch(items, "gpt")[0]?.value).toBe("gpt");
    expect(fuzzySearch(items, "").map((match) => match.value)).toEqual(["gpt-long", "gpt"]);
  });

  it("rejects invalid counts and caps overflow", () => {
    recordModelSelection("/one", "a");
    const key = [...storage.keys()][0]!;
    storage.set(key, JSON.stringify({ a: -1, b: 1.5, c: "3", d: Number.MAX_SAFE_INTEGER, e: 2 }));
    expect(readModelSelectionCounts("/one")).toEqual({ d: Number.MAX_SAFE_INTEGER, e: 2 });
    recordModelSelection("/one", "d");
    expect(readModelSelectionCounts("/one").d).toBe(Number.MAX_SAFE_INTEGER);
    storage.set(key, "[]");
    expect(readModelSelectionCounts("/one")).toEqual({});
  });

  it("logs malformed or unavailable storage without breaking selection", () => {
    recordModelSelection("/one", "a");
    storage.set([...storage.keys()][0]!, "invalid json");
    expect(readModelSelectionCounts("/one")).toEqual({});
    expect(report).toHaveBeenCalledOnce();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("full"); } });
    expect(() => recordModelSelection("/one", "a")).not.toThrow();
    expect(report).toHaveBeenCalledTimes(2);
  });
});
