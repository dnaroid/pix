import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import wikiConflictsExtension, { parseWikiConflictsParams, WIKI_CONFLICTS_TOOL } from "../src/extensions/wiki-conflicts.js";
import type { KnowledgeCheckResult } from "../src/knowledge/contract.js";
import { knowledgeFindingId } from "../src/knowledge/decisions.js";
import { recordKnowledgeCheck, recordKnowledgeDecision } from "../src/knowledge/stamp.js";
import { initializedProjectWiki, scanWikiFindings } from "../src/knowledge/wiki-findings-scan.js";

const checkedAt = "2026-10-30T12:00:00.000Z";
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const draft = { path: "wiki/policy.md", quote: "Draft claim.", startLine: 2, endLine: 2 };
const existing = { path: "wiki/rules.md", quote: "Source claim.", startLine: 3, endLine: 3 };
const other = { path: "wiki/other.md", quote: "Other claim.", startLine: 1, endLine: 1 };
const body = "# Policy\nDraft claim.\n";

function result(): KnowledgeCheckResult {
  return { status: "conflicts", path: draft.path, documentHash: hash(body), modelRef: "test/model", checkedSources: 2,
    conflicts: [{ draft, existing, explanation: "Incompatible." }],
    uncertainties: [{ draft, existing: other, explanation: "Unclear scope." }], notices: [] };
}

async function project(t: test.TestContext, withIndex = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pix-wiki-conflicts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "wiki", "nested"), { recursive: true });
  if (withIndex) await writeFile(join(root, "wiki", "index.md"), "# Index\n");
  return root;
}

test("detects an initialized Wiki from workspace config and the index file", async (t) => {
  const root = await project(t, false);
  assert.equal(await initializedProjectWiki(root), undefined);
  await mkdir(join(root, ".pi"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "home.md"), "# Home\n");
  await writeFile(join(root, ".pi", "workspace.jsonc"), `{ // custom\n "wiki": { "path": "docs", "index": "home.md" }, }`);
  assert.deepEqual(await initializedProjectWiki(root), { root: await (await import("node:fs/promises")).realpath(root), path: "docs", indexPath: "docs/home.md" });
  await writeFile(join(root, ".pi", "workspace.jsonc"), `{ "wiki": { "path": "../x" } }`);
  await assert.rejects(initializedProjectWiki(root), /inside the project/u);
});

test("scans saved reports, merges decisions and filters by status, kind and path", async (t) => {
  const root = await project(t);
  const id = await knowledgeFindingId("conflict", draft, existing);
  const saved = await recordKnowledgeDecision(await recordKnowledgeCheck(body, result(), checkedAt), id,
    { verdict: "false-positive", note: "Different modes.", at: "2026-10-30T13:00:00.000Z" });
  await writeFile(join(root, "wiki", "policy.md"), saved);
  await writeFile(join(root, "wiki", "nested", "plain.md"), "# Plain\n");
  await writeFile(join(root, "wiki", ".hidden.md"), saved);
  await symlink(join(root, "wiki", "policy.md"), join(root, "wiki", "nested", "link.md"));
  const wiki = (await initializedProjectWiki(root))!;

  const all = await scanWikiFindings(wiki);
  assert.equal(all.findings.length, 2);
  assert.deepEqual(all.summary, { conflicts: 0, uncertainties: 1, internal: 0, fixPending: 0, decided: 1, stale: 0, total: 2 });
  assert.equal(all.scannedPages, 3);
  assert.equal(all.truncated, false);

  assert.deepEqual((await scanWikiFindings(wiki, { status: "open" })).findings.map(item => item.kind), ["uncertainty"]);
  assert.equal((await scanWikiFindings(wiki, { status: "decided" })).findings[0]?.decision?.note, "Different modes.");
  assert.equal((await scanWikiFindings(wiki, { kind: "conflict" })).findings.length, 1);
  assert.equal((await scanWikiFindings(wiki, { branch: "wiki/other.md" })).findings.length, 1);
  assert.equal((await scanWikiFindings(wiki, { branch: "wiki/nested" })).findings.length, 0);
});

test("validates tool parameters with an open default", () => {
  assert.deepEqual(parseWikiConflictsParams({}), { filter: { status: "open" }, limit: 30 });
  assert.deepEqual(parseWikiConflictsParams({ status: "all", kind: "internal", path: "./wiki/a", limit: 5 }),
    { filter: { kind: "internal", branch: "wiki/a" }, limit: 5 });
  assert.throws(() => parseWikiConflictsParams({ status: "done" }), /status/u);
  assert.throws(() => parseWikiConflictsParams({ limit: 0 }), /limit/u);
});

test("the tool is inactive by default and activated only for runs in a project with an initialized Wiki", async (t) => {
  const ready = await project(t);
  const bare = await project(t, false);
  let active: string[] = ["read"];
  let tool: any, handler: any;
  const api = {
    registerTool: (definition: unknown) => { tool = definition; },
    on: (event: string, fn: unknown) => { if (event === "before_agent_start") handler = fn; },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = names; },
  };
  wikiConflictsExtension(api as never);
  assert.equal(tool.name, WIKI_CONFLICTS_TOOL);
  assert.equal(tool.defaultActive, false);

  const run = (cwd: string) => handler({ systemPromptOptions: { cwd } });
  await run(bare);
  assert.deepEqual(active, ["read"]);
  await run(ready);
  assert.deepEqual(active, ["read", WIKI_CONFLICTS_TOOL]);
  await run(ready);
  assert.deepEqual(active, ["read", WIKI_CONFLICTS_TOOL]);
  await run(bare);
  assert.deepEqual(active, ["read"]);

  const refused = await tool.execute("1", {}, undefined, undefined, { cwd: bare });
  assert.equal(refused.isError, true);
  const listed = await tool.execute("2", { status: "all" }, undefined, undefined, { cwd: ready });
  assert.equal(listed.isError, undefined);
  assert.deepEqual(JSON.parse(listed.content[0].text).summary.total, 0);
});
