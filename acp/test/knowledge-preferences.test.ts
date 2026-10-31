import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKnowledgeReportLanguage } from "../src/knowledge/preferences.js";

async function configs(t: TestContext) {
  const artifacts = fileURLToPath(new URL("../../.pi/artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "knowledge-language-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { desktopPath: join(root, "pix-desktop.jsonc"), suitePath: join(root, "pi-tools-suite.jsonc") };
}

test("missing language preferences use English without creating config files", async t => {
  const paths = await configs(t);
  assert.equal(await loadKnowledgeReportLanguage(paths), "en");
  for (const path of Object.values(paths)) await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("explicit Desktop report language overrides the suite preference", async t => {
  const paths = await configs(t);
  await writeFile(paths.suitePath, '{"knowledgeCheck":{"reportLanguage":"ru"}}');
  assert.equal(await loadKnowledgeReportLanguage(paths), "ru");
  await writeFile(paths.desktopPath, '{"knowledgeCheck":{"reportLanguage":"en"}}');
  assert.equal(await loadKnowledgeReportLanguage(paths), "en");
  await writeFile(paths.suitePath, '{"knowledgeCheck":{"reportLanguage":"en"}}');
  await writeFile(paths.desktopPath, '{"knowledgeCheck":{"reportLanguage":"ru"}}');
  assert.equal(await loadKnowledgeReportLanguage(paths), "ru");
});

test("empty, omitted, invalid and malformed Desktop values inherit the suite language", async t => {
  const paths = await configs(t);
  await writeFile(paths.suitePath, '{"knowledgeCheck":{"reportLanguage":"ru"}}');
  for (const source of ["{}", '{"knowledgeCheck":{}}', '{"knowledgeCheck":{"reportLanguage":""}}',
    '{"knowledgeCheck":{"reportLanguage":"fr"}}', '{"knowledgeCheck":{"reportLanguage":false}}',
    '{"knowledgeCheck":{"reportLanguage":["en"]}}', '{"knowledgeCheck":[{"reportLanguage":"en"}]}',
    '{"knowledgeCheck":{"reportLanguage":"en"}', "null", "[]"]) {
    await writeFile(paths.desktopPath, source);
    assert.equal(await loadKnowledgeReportLanguage(paths), "ru", source);
  }
});

test("invalid suite preferences fall back to English and unrelated language settings do not apply", async t => {
  const paths = await configs(t);
  for (const source of ['{"knowledgeCheck":{"reportLanguage":"de"}}', '{"knowledgeCheck":{"reportLanguage":12}}',
    '{"knowledgeCheck":{"reportLanguage":"ru"}', '{"selectionAssist":{"language":"ru"}}', "[]"]) {
    await writeFile(paths.suitePath, source);
    assert.equal(await loadKnowledgeReportLanguage(paths), "en", source);
  }
});

test("JSONC comments and trailing commas are supported and preference changes apply to the next check", async t => {
  const paths = await configs(t);
  await writeFile(paths.suitePath, '{ // User preference\n"knowledgeCheck":{"reportLanguage":"ru",},}');
  await writeFile(paths.desktopPath, '{"knowledgeCheck":{"reportLanguage":"",}}');
  assert.equal(await loadKnowledgeReportLanguage(paths), "ru");
  await writeFile(paths.suitePath, '{"knowledgeCheck":{"reportLanguage":"en"}}');
  assert.equal(await loadKnowledgeReportLanguage(paths), "en");
});
