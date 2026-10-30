import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { editWikiAutoCheckSettings, getWikiAutoCheckSettings, isWikiAutoCheckRunId } from "./wiki-auto-check-config";

const first = "701e52bd-0094-4ff9-a004-c745ecba75d4";
const second = "5674cf00-cd92-4aa2-93c2-03b2c5d9525c";

describe("Wiki background checking project policy", () => {
  it("defaults to off without creating an implicit pass", () => {
    expect(getWikiAutoCheckSettings()).toEqual({ enabled: false });
    expect(getWikiAutoCheckSettings("{}")).toEqual({ enabled: false });
    expect(getWikiAutoCheckSettings('{"wiki":{"path":"docs/wiki"}}')).toEqual({ enabled: false });
  });

  it("accepts a manually enabled policy awaiting its first persisted pass ID", () => {
    expect(getWikiAutoCheckSettings('{"wiki":{"autoCheck":true}}')).toEqual({ enabled: true });
  });

  it("reads JSONC without changing unrelated Wiki or project settings", () => {
    const source = [
      "{", "// This preference belongs to the project.",
      '"color": "#abcdef",',
      '"wiki": { "path": "docs/game", "autoCheck": true, "autoCheckRunId": "' + first + '", },',
      "}",
    ].join("\n");
    expect(getWikiAutoCheckSettings(source)).toEqual({ enabled: true, runId: first });
    expect(parse(source).wiki.path).toBe("docs/game");
  });

  it.each(["", "{", "[]", "null", "true", '{"wiki":null}', '{"wiki":[]}'])
    ("rejects malformed workspace content: %s", source => {
      expect(() => getWikiAutoCheckSettings(source)).toThrow();
      expect(() => editWikiAutoCheckSettings(source, true, first)).toThrow();
    });

  it.each(["true", 1, null, {}, []])("requires a boolean opt-in: %s", autoCheck => {
    expect(() => getWikiAutoCheckSettings(JSON.stringify({ wiki: { autoCheck } }))).toThrow(/wiki\.autoCheck/u);
  });

  it.each(["", "pass-1", "../pass", "a".repeat(500), null, 1, {}, []])("requires a bounded UUID: %s", autoCheckRunId => {
    expect(isWikiAutoCheckRunId(autoCheckRunId)).toBe(false);
    expect(() => getWikiAutoCheckSettings(JSON.stringify({ wiki: { autoCheckRunId } }))).toThrow(/autoCheckRunId/u);
  });

  it("does not silently select one of duplicate controlled settings", () => {
    for (const source of [
      '{"wiki":{},"wiki":{"autoCheck":true}}',
      '{"wiki":{"autoCheck":false,"autoCheck":true}}',
      '{"wiki":{"autoCheckRunId":"' + first + '","autoCheckRunId":"' + second + '"}}',
    ]) expect(() => getWikiAutoCheckSettings(source)).toThrow(/duplicate/u);
  });

  it("preserves a valid persisted pass ID exactly", () => {
    const upper = first.toUpperCase();
    expect(isWikiAutoCheckRunId(upper)).toBe(true);
    expect(getWikiAutoCheckSettings(JSON.stringify({ wiki: { autoCheck: true, autoCheckRunId: upper } })))
      .toEqual({ enabled: true, runId: upper });
  });

  it("creates the policy and pass in the same new workspace document", () => {
    const source = editWikiAutoCheckSettings(undefined, true, first);
    expect(getWikiAutoCheckSettings(source)).toEqual({ enabled: true, runId: first });
    expect(parse(source).$schema).toContain("schemas/workspace.json");
  });

  it("initializes the missing ID without dropping a manually chosen Wiki root", () => {
    const source = editWikiAutoCheckSettings('{"wiki":{"path":"docs/game","autoCheck":true}}', true, first);
    expect(parse(source).wiki).toEqual({ path: "docs/game", autoCheck: true, autoCheckRunId: first });
  });

  it("preserves comments, CRLF, custom schema and unrelated settings when starting a new pass", () => {
    const source = [
      "{", '  "$schema": "custom://schema",',
      "  // Keep this project identity.", '  "color": "#123456",',
      '  "wiki": {', '    "path": "design/wiki",',
      "    // Keep this home page.", '    "index": "guide.md",',
      '    "autoCheck": false,', '    "autoCheckRunId": "' + first + '",', "  },",
      '  "search": { "sources": { "code": true } }', "}", "",
    ].join("\r\n");
    const next = editWikiAutoCheckSettings(source, true, second);
    expect(getWikiAutoCheckSettings(next)).toEqual({ enabled: true, runId: second });
    expect(next).toContain("// Keep this project identity.\r\n");
    expect(next).toContain("// Keep this home page.\r\n");
    expect(next).not.toMatch(/(?<!\r)\n/u);
    expect(parse(next)).toEqual({
      $schema: "custom://schema", color: "#123456",
      wiki: { path: "design/wiki", index: "guide.md", autoCheck: true, autoCheckRunId: second },
      search: { sources: { code: true } },
    });
  });

  it("stopping retains the pass ID so its active request can still checkpoint", () => {
    const source = JSON.stringify({ wiki: { autoCheck: true, autoCheckRunId: first, index: "home.md" } });
    const next = editWikiAutoCheckSettings(source, false);
    expect(parse(next).wiki).toEqual({ autoCheck: false, autoCheckRunId: first, index: "home.md" });
  });

  it("does not generate an unpersisted or invalid identity as a serialization side effect", () => {
    expect(() => editWikiAutoCheckSettings("{}", true)).toThrow(/UUID/u);
    expect(() => editWikiAutoCheckSettings("{}", true, "not-a-uuid")).toThrow(/UUID/u);
  });
});
