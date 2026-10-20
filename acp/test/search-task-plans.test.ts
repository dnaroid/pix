import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTaskSemanticCorpus } from "../src/search/task-corpus.js";
import { readPlanFiles, taskSnapshot, taskSourceRevision } from "../src/search/task-snapshot.js";

const signal = new AbortController().signal;

test("saved plans join the task corpus and the task source revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-task-plans-"));
  try {
    await mkdir(join(root, ".pi", "plans", "nested"), { recursive: true });
    const empty = await taskSourceRevision(root, signal);
    assert.equal(empty, await taskSnapshot(join(root, ".pi", "tasks.sqlite"), signal));
    await writeFile(join(root, ".pi", "plans", "nested", "rollout.md"), "# Kinetic rollout\n\n- [ ] migrate devices\n");
    await writeFile(join(root, ".pi", "plans", "notes.txt"), "ignored");
    await symlink(join(root, ".pi", "plans", "nested", "rollout.md"), join(root, ".pi", "plans", "link.md"));
    assert.deepEqual((await readPlanFiles(root, signal)).map(plan => plan.path), [".pi/plans/nested/rollout.md"]);
    const docs = await readTaskSemanticCorpus(root, signal);
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.id, "plan:.pi/plans/nested/rollout.md#0");
    assert.equal(docs[0]!.planPath, ".pi/plans/nested/rollout.md");
    assert.equal(docs[0]!.title, "Kinetic rollout");
    assert.match(docs[0]!.text, /migrate devices/);
    const withPlan = await taskSourceRevision(root, signal);
    assert.notEqual(withPlan, empty);
    await writeFile(join(root, ".pi", "plans", "nested", "rollout.md"), "# Kinetic rollout\n\n- [x] migrate devices\n");
    assert.notEqual(await taskSourceRevision(root, signal), withPlan);
    // Long plans are chunked: the tail stays searchable and every chunk carries plan context.
    await writeFile(join(root, ".pi", "plans", "nested", "rollout.md"), `# Kinetic rollout\n\n${"filler line\n".repeat(600)}TAIL-MARKER\n`);
    const chunks = await readTaskSemanticCorpus(root, signal);
    assert.ok(chunks.length > 1);
    assert.deepEqual(chunks.map(doc => doc.id), chunks.map((_, index) => `plan:.pi/plans/nested/rollout.md#${index}`));
    assert.ok(chunks.every(doc => doc.planPath === ".pi/plans/nested/rollout.md" && doc.text.startsWith("Plan path: .pi/plans/nested/rollout.md\nPlan title: Kinetic rollout")));
    assert.match(chunks.at(-1)!.text, /TAIL-MARKER/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
