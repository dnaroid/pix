import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createQaWorkspace, seedQaWorkspace } from "../../qa-workspace.mjs";
import { parseArguments } from "../../qa-desktop/cli.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const run = promisify(execFile);

async function scratch(t) {
  const parent = join(root, ".pi", "artifacts");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "qa-workspace-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("fresh QA projects are independent, seeded and have no real state", async (t) => {
  const checkout = await scratch(t);
  const first = await createQaWorkspace(checkout);
  const second = await createQaWorkspace(checkout);
  assert.notEqual(first.workspace, second.workspace);
  assert.equal(first.kind, "pix-qa-sandbox");
  assert.match(await readFile(join(first.workspace, "docs/notes.md"), "utf8"), /безопасная песочница/u);
  assert.match(await readFile(join(first.workspace, "data/items.json"), "utf8"), /QA_SEARCH_BETA/u);
  assert.equal((await readdir(first.workspace)).includes(".pi"), false);
  assert.equal((await readdir(first.workspace)).includes(".git"), true);
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  assert.equal((await run("git", ["rev-parse", "--show-toplevel"], { cwd: first.workspace, env: gitEnv })).stdout.trim(), first.workspace);
  assert.equal((await run("git", ["remote"], { cwd: first.workspace, env: gitEnv })).stdout.trim(), "");
  await assert.rejects(run("git", ["rev-parse", "--verify", "HEAD"], { cwd: first.workspace, env: gitEnv }));
  assert.equal((await readdir(join(first.workspace, ".git"))).includes("hooks"), false);
  await writeFile(join(first.workspace, "src/greeting.mjs"), "modified\n");
  assert.match(await readFile(join(second.workspace, "src/greeting.mjs"), "utf8"), /export function greeting/u);
  assert.match(await readFile(join(root, "fixtures/qa/pix-project/src/greeting.mjs"), "utf8"), /export function greeting/u);
});

test("seeding rejects populated and symlink workspaces without overwriting", async (t) => {
  const directory = await scratch(t);
  const populated = join(directory, "populated");
  await mkdir(populated);
  await writeFile(join(populated, "keep.txt"), "keep");
  await assert.rejects(seedQaWorkspace(populated), /empty, non-symlink/u);
  assert.equal(await readFile(join(populated, "keep.txt"), "utf8"), "keep");
  const empty = join(directory, "empty");
  await mkdir(empty);
  const link = join(directory, "link");
  await symlink(empty, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(seedQaWorkspace(link), /empty, non-symlink/u);
  assert.deepEqual(await readdir(empty), []);
});

test("Git initialization does not honor inherited repository overrides", async (t) => {
  const checkout = await scratch(t);
  const outside = join(checkout, "outside-git");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep");
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = outside;
  let project;
  try {
    project = await createQaWorkspace(checkout);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
  assert.deepEqual(await readdir(outside), ["keep.txt"]);
  assert.equal((await readdir(project.workspace)).includes(".git"), true);
});

test("standalone setup rejects redirected artifact storage", async (t) => {
  const checkout = await scratch(t);
  const outside = join(checkout, "outside");
  await mkdir(outside);
  await mkdir(join(checkout, ".pi"));
  await symlink(outside, join(checkout, ".pi/artifacts"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createQaWorkspace(checkout), /must not be redirected/u);
  assert.deepEqual(await readdir(outside), []);
});

test("empty workspace is an explicit prepare-only option", () => {
  assert.equal(parseArguments(["prepare"]).emptyWorkspace, undefined);
  assert.equal(parseArguments(["prepare", "--empty-workspace"]).emptyWorkspace, true);
  assert.throws(() => parseArguments(["prepare", "--empty-workspace", "--empty-workspace"]), /duplicate/u);
  assert.throws(() => parseArguments(["launch", "--empty-workspace"]), /unknown/u);
});

test("standalone setup rejects redirected .pi before creating artifacts", async (t) => {
  const checkout = await scratch(t);
  const outside = join(checkout, "outside");
  await mkdir(outside);
  await symlink(outside, join(checkout, ".pi"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createQaWorkspace(checkout), /must not be redirected/u);
  assert.deepEqual(await readdir(outside), []);
});
