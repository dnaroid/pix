import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Writer (ACP) and observer (native probe) must share identical coverage/revision logic.
const suite = new URL("../../external/pi-tools-suite/src/project-search/", import.meta.url);
const acp = new URL("../src/search/", import.meta.url);
const MIRRORED = ["source-coverage", "commit-stamp", "task-snapshot", "session-watermark", "session-index-revision", "source-work"];

for (const name of MIRRORED) {
  test(`${name} is mirrored verbatim from pi-tools-suite`, async () => {
    const source = (await readFile(fileURLToPath(new URL(`${name}.mjs`, suite)), "utf8")).replace(/\.mjs"/g, ".js\"");
    assert.equal(await readFile(fileURLToPath(new URL(`${name}.js`, acp)), "utf8"), source);
  });
}
