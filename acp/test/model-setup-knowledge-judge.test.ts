import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { parse } from "jsonc-parser";
import { MODEL_SLOTS, applyRolesToDesktopConfig, applyRolesToPixConfig, applyRolesToSuiteConfig,
  currentSlotValues, loadModelSetupStatus, parseSetupRequest, setupConfigPaths, writeRoles } from "../src/acp/model-setup.js";
import { loadKnowledgeModelPreferences } from "../src/knowledge/model-preferences.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const roles = { main: "p/main", fast: "p/fast", strong: "p/strong" };
const original = '{\n // Keep the report language.\n "knowledgeCheck":{"modelRef":"p/judge","thinking":"high","reportLanguage":"ru"},\n "search":{"ragModelRef":"p/search","ragThinking":"max"}\n}';

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "wiki-judge-wizard-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = setupConfigPaths(home);
  await mkdir(dirname(paths.suite), { recursive: true });
  return { home, paths, read: async (path: string) => parse(await readFile(path, "utf8")),
    effective: () => loadKnowledgeModelPreferences(home, { desktopPath: paths.desktop, suitePath: paths.suite }) };
}

test("wizard offers independent optional shared and Desktop judge slots with reasoning", () => {
  const shared = MODEL_SLOTS.find(slot => slot.id === "knowledge-judge")!;
  const desktop = MODEL_SLOTS.find(slot => slot.id === "knowledge-judge-desktop")!;
  assert.equal(shared.file, "suite");
  assert.equal(desktop.file, "desktop");
  assert.equal(shared.group, "Assistant");
  assert.equal(desktop.parent, shared.id);
  for (const slot of [shared, desktop]) { assert.equal(slot.optional, true); assert.equal(slot.thinking, true); }
  assert.equal(shared.emptyLabel, "No judge selected");
  assert.equal(desktop.emptyLabel, "Use Tools Suite setting");
});

test("roles never silently assign a judge; untouched judge fields and JSONC comments survive", () => {
  for (const apply of [applyRolesToPixConfig, applyRolesToDesktopConfig, applyRolesToSuiteConfig]) {
    assert.equal(parse(apply("{}", roles)).knowledgeCheck, undefined);
    const updated = apply(original, roles);
    assert.deepEqual(parse(updated).knowledgeCheck, parse(original).knowledgeCheck);
    assert.match(updated, /Keep the report language/u);
  }
});

test("explicit picks are stored in the correct profiles and read back, never in TUI", async t => {
  const f = await fixture(t);
  await writeFile(f.paths.desktop, original);
  await writeFile(f.paths.suite, original);
  writeRoles(roles, f.home, { "knowledge-judge": "p/shared", "knowledge-judge:thinking": "low",
    "knowledge-judge-desktop": "p/desktop", "knowledge-judge-desktop:thinking": "off", rag: "p/search" });
  assert.deepEqual((await f.read(f.paths.suite)).knowledgeCheck, { modelRef: "p/shared", thinking: "low", reportLanguage: "ru" });
  assert.deepEqual((await f.read(f.paths.desktop)).knowledgeCheck, { modelRef: "p/desktop", thinking: "off", reportLanguage: "ru" });
  assert.deepEqual((await f.read(f.paths.desktop)).search, { ragModelRef: "p/search", ragThinking: "max" });
  assert.equal((await f.read(f.paths.pix)).knowledgeCheck, undefined);
  const current = currentSlotValues(f.home);
  assert.equal(current["knowledge-judge"], "p/shared");
  assert.equal(current["knowledge-judge:thinking"], "low");
  assert.equal(current["knowledge-judge-desktop"], "p/desktop");
  assert.equal(current["knowledge-judge-desktop:thinking"], "off");
  assert.deepEqual(await f.effective(), { modelRef: "p/desktop", thinking: "off" });
});

test("model and reasoning independently reset to Suite and round-trip through the status RPC", async t => {
  const f = await fixture(t);
  await writeFile(f.paths.desktop, original);
  await writeFile(f.paths.suite, '{"knowledgeCheck":{"modelRef":"p/shared","thinking":"low"}}');
  writeRoles(roles, f.home, { "knowledge-judge-desktop": "" });
  assert.deepEqual(await f.effective(), { modelRef: "p/shared", thinking: "high" });
  const runtime = { getAvailable: async () => [] } as unknown as ModelRuntime;
  const status = await loadModelSetupStatus(f.home, async () => runtime);
  assert.equal(status.currentSlots["knowledge-judge-desktop"], undefined);
  assert.equal(status.currentThinking["knowledge-judge-desktop"], "high");
  writeRoles(roles, f.home, { "knowledge-judge-desktop:thinking": "" });
  assert.deepEqual(await f.effective(), { modelRef: "p/shared", thinking: "low" });
  assert.deepEqual((await f.read(f.paths.desktop)).knowledgeCheck, { reportLanguage: "ru" });
  assert.equal(currentSlotValues(f.home)["knowledge-judge-desktop:thinking"], undefined);
});

test("reasoning-only changes preserve model inheritance; clearing Suite reasoning uses low", async t => {
  const f = await fixture(t);
  await writeFile(f.paths.desktop, '{"knowledgeCheck":{"reportLanguage":"ru"}}');
  await writeFile(f.paths.suite, original);
  writeRoles(roles, f.home, { "knowledge-judge-desktop:thinking": "medium" });
  assert.deepEqual(await f.effective(), { modelRef: "p/judge", thinking: "medium" });
  assert.equal((await f.read(f.paths.desktop)).knowledgeCheck.modelRef, undefined);
  writeRoles(roles, f.home, { "knowledge-judge:thinking": "", "knowledge-judge-desktop:thinking": "" });
  assert.deepEqual(await f.effective(), { modelRef: "p/judge", thinking: "low" });
});

test("Desktop judge values never inherit irrelevant TUI fields or create a partial Desktop profile", async t => {
  const f = await fixture(t);
  await writeFile(f.paths.pix, original);
  writeRoles(roles, f.home, { "knowledge-judge": "p/shared", "knowledge-judge-desktop": "p/desktop" });
  assert.equal(existsSync(f.paths.desktop), false);
  assert.equal(currentSlotValues(f.home)["knowledge-judge-desktop"], undefined);
  assert.equal(currentSlotValues(f.home)["knowledge-judge-desktop:thinking"], undefined);
  assert.deepEqual(await f.effective(), { modelRef: "p/shared", thinking: "low" });
  assert.equal((await f.read(f.paths.pix)).knowledgeCheck.modelRef, "p/judge");
});

test("RPC validates judge references without a thinking suffix and retains explicit empty resets", () => {
  const overrides = { "knowledge-judge": "zai/glm-5.3-flash", "knowledge-judge:thinking": "low",
    "knowledge-judge-desktop": "", "knowledge-judge-desktop:thinking": "" };
  assert.deepEqual(parseSetupRequest({ ...roles, overrides }).overrides, overrides);
  for (const id of ["knowledge-judge", "knowledge-judge-desktop"]) {
    for (const value of ["bad", "p/model:low", "p/model:free", "p/model name", "p/" + "x".repeat(256), ["p/model"], 42]) {
      assert.throws(() => parseSetupRequest({ ...roles, overrides: { [id]: value } }), /judge model ref/u);
    }
    for (const value of ["invalid", ["low"], null]) {
      assert.throws(() => parseSetupRequest({ ...roles, overrides: { [`${id}:thinking`]: value } }), /invalid thinking/u);
    }
  }
});
