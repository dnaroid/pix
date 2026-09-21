import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const testsDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(testsDir, "../src/app/app.ts"), "utf8");

describe("TUI startup critical path", () => {
  it("does not await the draft model catalog before restoring startup tabs", () => {
    const start = appSource.indexOf("private async loadStartupConfig()");
    const end = appSource.indexOf("private ensureDraftModelCatalog()", start);
    assert.ok(start >= 0 && end > start);
    const startupConfig = appSource.slice(start, end);
    assert.doesNotMatch(startupConfig, /createPixDraftModelCatalog/u);
    assert.doesNotMatch(startupConfig, /await this\.refreshDraftModelCatalog/u);
    assert.match(startupConfig, /this\.resetDraftModelSelection\(\)/u);
  });

  it("loads the draft catalog lazily from draft-tab activation", () => {
    assert.match(appSource, /ensureDraftModelCatalog: \(\) => this\.ensureDraftModelCatalog\(\)/u);
    assert.match(appSource, /if \(this\.draftModelCatalogLoaded \|\| this\.draftModelCatalogLoad\) return;/u);
  });
});
