import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { replaceLocalWorkspace } from "../src/registry/workspace-file.js";
import { hashProjectArtifactLocal } from "../src/registry/task-bundle.js";
import { writeSourcePolicy, readSourcePolicy } from "../src/search/source-policy.js";
import { withSourcePolicyWriteLock } from "../src/search/source-policy-lock.js";

test("Registry workspace pull rechecks conflicts under the shared mutex and installs with a fresh search generation", async t => {
  const base = fileURLToPath(new URL("../../.pi/artifacts/registry-workspace-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pi"));
  const file = join(root, ".pi/workspace.jsonc"), remote = join(root, "remote.jsonc");
  await writeFile(file, '{"search":{"sources":{"code":false},"revision":"remote-old"}}');
  await writeFile(remote, '{ /* registry comment */ "search":{"sources":{"code":true},"revision":"remote-old"},"color":"#123456"}');
  const expected = await hashProjectArtifactLocal(root, "workspace");
  await writeSourcePolicy(root, "tasks", true);
  const local = await readFile(file, "utf8");
  await assert.rejects(replaceLocalWorkspace(root, remote, expected), /changed while pulling/);
  assert.equal(await readFile(file, "utf8"), local);
  const current = await hashProjectArtifactLocal(root, "workspace");
  let pulling: Promise<string>;
  await withSourcePolicyWriteLock(root, async () => {
    pulling = replaceLocalWorkspace(root, remote, current);
    // The pull cannot finish before this ownership is released.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await readFile(file, "utf8"), local);
  });
  const installedHash = await pulling!;
  assert.equal(installedHash, await hashProjectArtifactLocal(root, "workspace"));
  const saved = await readFile(file, "utf8");
  assert.ok(saved.includes("/* registry comment */"));
  assert.ok(!saved.includes('"remote-old"'));
  assert.equal((await readSourcePolicy(root)).enabled.code, true);
  assert.ok(saved.includes('"color":"#123456"'));
  const policy = await readSourcePolicy(root);
  const newer = await replaceLocalWorkspace(root, remote, installedHash);
  assert.equal((await readSourcePolicy(root)).revision, policy.revision, "unrelated pull retains the local search generation");
  await writeSourcePolicy(root, "tasks", true);
  assert.notEqual(newer, await hashProjectArtifactLocal(root, "workspace"), "post-pull edits are not recorded as the installed baseline");
});
