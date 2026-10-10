import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";

import { hasTrackableFiles } from "../src/registry/paths.js";
import { copyTree, hashPath, hashResource, replaceLocalPlans } from "../src/registry/resource-files.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-canonical-"));
	directories.push(root);
	return root;
}

function put(root: string, relative: string, content: string): string {
	const filename = path.join(root, relative);
	fs.mkdirSync(path.dirname(filename), { recursive: true });
	fs.writeFileSync(filename, content);
	return filename;
}

test("project plans use a Markdown-only allowlist for discovery, hashing, and publication", async () => {
	const root = fixture();
	const plans = path.join(root, "plans");
	fs.mkdirSync(plans);
	put(plans, "scratch.sqlite", "1");
	put(plans, "notes.md.tmp", "temporary plan");
	put(plans, ".cache/snapshot.md", "hidden");
	put(plans, "artifacts/report.md", "generated");
	put(plans, "build/output.log", "output");
	assert.equal(await hasTrackableFiles(plans), false);
	put(plans, "roadmap.md", "# Plan\n");
	put(plans, "milestones/v1.MD", "# Milestone\n");
	assert.equal(await hasTrackableFiles(plans), true);
	const baseline = await hashPath(plans, "plans");
	put(plans, "roadmap.md-wal", "wal");
	put(plans, "milestones/v1.MD.bak", "backup");
	put(plans, "milestones/notes.txt", "non-plan");
	put(plans, "cache/generated.md", "service");
	assert.equal(await hashPath(plans, "plans"), baseline);
	const published = path.join(root, "published");
	await copyTree(plans, published, "", "plans");
	assert.deepEqual(fs.readdirSync(published), ["milestones", "roadmap.md"]);
	assert.deepEqual(fs.readdirSync(path.join(published, "milestones")), ["v1.MD"]);
	assert.equal(await hashPath(published, "plans"), baseline);
	put(plans, "milestones/v1.MD", "# Changed\n");
	assert.notEqual(await hashPath(plans, "plans"), baseline);
});

test("resource packages ignore transient output but include authored scripts and assets", async () => {
	const root = fixture();
	const skill = path.join(root, "skill");
	put(skill, "SKILL.md", "# Canonical\n");
	put(skill, "scripts/run.js", "console.log('run')\n");
	put(skill, "assets/icon.bin", "asset-v1");
	const baseline = await hashPath(skill);
	put(skill, ".DS_Store", "finder");
	put(skill, ".cache/calls.json", "cache");
	put(skill, "__pycache__/module.pyc", "cached bytecode");
	put(skill, "node_modules/lib/index.js", "dependency");
	put(skill, "artifacts/evidence.md", "generated evidence");
	put(skill, "scripts/test.log.tmp", "temp");
	put(skill, "assets/icon.bin.lock", "lock");
	put(skill, "scripts/output.txt~", "editor backup");
	put(skill, "scratchdir/only.log", "generated output");
	put(skill, "emptydir/.cache.txt", "hidden output");
	assert.equal(await hashPath(skill), baseline);
	const destination = path.join(root, "published");
	await copyTree(skill, destination);
	assert.equal(await hashPath(destination), baseline);
	assert.deepEqual(fs.readdirSync(destination), ["SKILL.md", "assets", "scripts"]);
	put(skill, "scripts/run.js", "console.log('changed')\n");
	assert.notEqual(await hashPath(skill), baseline);
});

test("agent companions with only generated files do not become Registry content", async () => {
	const root = fixture();
	const agent = put(root, "agents/author.md", "---\nname: author\n---\nAgent\n");
	const initialHash = await hashResource("agent", agent);
	put(root, "agents/author/__pycache__/compiled.pyc", "generated");
	put(root, "agents/author/scratch/trace.log", "generated");
	assert.equal(await hashResource("agent", agent), initialHash);
	put(root, "agents/author/scripts/tool.js", "export const answer = 42;\n");
	assert.notEqual(await hashResource("agent", agent), initialHash);
});

test("plan pull changes only canonical Markdown and retains local service files", async () => {
	const root = fixture();
	const source = path.join(root, "remote-plans");
	const target = path.join(root, "local-plans");
	put(source, "current.md", "# Remote\n");
	put(source, "current.md.tmp", "unpublished remote scratch");
	put(target, "old.md", "# Removed\n");
	put(target, "current.md", "# Local\n");
	put(target, "scratch.sqlite", "local scratch");
	put(target, "artifacts/snapshot.md", "local generated report");
	put(target, "current.md.bak", "local backup");
	await replaceLocalPlans(source, target);
	assert.equal(fs.existsSync(path.join(target, "old.md")), false);
	assert.equal(fs.readFileSync(path.join(target, "current.md"), "utf8"), "# Remote\n");
	assert.equal(fs.readFileSync(path.join(target, "scratch.sqlite"), "utf8"), "local scratch");
	assert.equal(fs.readFileSync(path.join(target, "artifacts/snapshot.md"), "utf8"), "local generated report");
	assert.equal(fs.readFileSync(path.join(target, "current.md.bak"), "utf8"), "local backup");
	assert.equal(fs.existsSync(path.join(target, "current.md.tmp")), false);
	assert.equal(await hashPath(source, "plans"), await hashPath(target, "plans"));
});

test("canonical plan symlinks fail closed without deleting local documents", async () => {
	if (process.platform === "win32") return;
	const root = fixture();
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	put(source, "valid.md", "# Valid\n");
	put(target, "kept.md", "# Keep\n");
	fs.symlinkSync(path.join(root, "outside.md"), path.join(source, "linked.md"));
	await assert.rejects(replaceLocalPlans(source, target), /symbolic link/i);
	assert.equal(fs.readFileSync(path.join(target, "kept.md"), "utf8"), "# Keep\n");
});
