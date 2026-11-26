import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { RegistryContext } from "../src/registry/context.js";
import { DesktopRegistryService } from "../src/registry/service.js";
import type { RegistryUiItem, RegistryUiSnapshot } from "../src/registry/model.js";

// Real Git scenarios: a deadlock ceiling, not a performance assertion.
const GIT_INTEGRATION_TIMEOUT_MS = 60_000;

const ENV_KEYS = [
	"HOME", "XDG_CACHE_HOME", "PI_CONFIG_DIR", "PI_RESOURCE_REGISTRY_REMOTE", "PI_RESOURCE_REGISTRY_BRANCH",
	"PI_RESOURCE_REGISTRY_PROJECT_KEY", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_GLOBAL",
] as const;
const originalEnv: Record<string, string | undefined> = {};
const roots: string[] = [];

beforeEach(() => { for (const key of ENV_KEYS) originalEnv[key] = process.env[key]; });
afterEach(() => {
	for (const key of ENV_KEYS) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
	return (result.stdout ?? "").trim();
}

const SKILL_V1 = "---\ndescription: Demo skill\n---\n\n# Demo\n\nintro\n\n## One\n\nfirst section\n\n## Two\n\nsecond section\n\n## Three\n\nthird section\n";

/** Isolated HOME/cache, a bare registry with `skills/demo/{SKILL.md,notes.md}` and two projects. */
async function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-registry-merge-"));
	roots.push(root);
	const home = path.join(root, "home");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(path.join(root, "cache"), { recursive: true });
	const gitConfig = path.join(home, ".gitconfig");
	fs.writeFileSync(gitConfig, "[core]\n\tautocrlf = false\n");
	process.env.GIT_CONFIG_GLOBAL = gitConfig;
	process.env.HOME = home;
	process.env.XDG_CACHE_HOME = path.join(root, "cache");
	for (const key of ["PI_CONFIG_DIR", "PI_RESOURCE_REGISTRY_REMOTE", "PI_RESOURCE_REGISTRY_BRANCH", "PI_RESOURCE_REGISTRY_PROJECT_KEY"]) delete process.env[key];
	process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Registry Test";
	process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "registry@example.test";

	const seed = path.join(root, "seed");
	const remote = path.join(root, "registry.git");
	fs.mkdirSync(path.join(seed, "skills", "demo"), { recursive: true });
	fs.writeFileSync(path.join(seed, "skills", "demo", "SKILL.md"), SKILL_V1);
	fs.writeFileSync(path.join(seed, "skills", "demo", "notes.md"), "notes v1\n");
	git(seed, ["init"]);
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "Initial resources"]);
	git(seed, ["branch", "-M", "main"]);
	git(root, ["init", "--bare", remote]);
	git(seed, ["remote", "add", "origin", remote]);
	git(seed, ["push", "-u", "origin", "main"]);

	const svc = new DesktopRegistryService();
	const projects = ["a", "b"].map((name) => {
		const cwd = path.join(root, name);
		fs.mkdirSync(cwd, { recursive: true });
		return { cwd, ctx: context(cwd, remote) };
	});
	await svc.action({ cwd: projects[0]!.cwd, action: "configure" }, projects[0]!.ctx);
	for (const project of projects) {
		const installed = await svc.action({ cwd: project.cwd, action: "install", type: "skill", name: "demo" }, project.ctx);
		assert.equal(installed.error, undefined);
	}
	const [a, b] = projects as [typeof projects[0], typeof projects[0]];
	const run = (project: typeof a, request: Record<string, unknown>) =>
		svc.action({ cwd: project.cwd, ...request } as Parameters<DesktopRegistryService["action"]>[0], project.ctx);
	return { remote, svc, a, b, run };
}

function context(cwd: string, remote: string): RegistryContext {
	return {
		cwd,
		hasUI: true,
		ui: {
			confirm: async () => true,
			input: async (title) => (title === "Registry Git remote" ? remote : "main"),
			editor: async () => undefined,
			notify: () => undefined,
		},
	};
}

function skillFile(cwd: string, file: string): string {
	return path.join(cwd, ".pi", "skills", "demo", file);
}

function item(snapshot: RegistryUiSnapshot, id = "skill:demo"): RegistryUiItem {
	const found = snapshot.items.find((entry) => entry.id === id);
	assert.ok(found, `snapshot item ${id} exists`);
	return found;
}

function registryFile(remote: string, file: string): string {
	return git(remote, ["show", `main:skills/demo/${file}`]) + "\n";
}

function provenance(cwd: string): string {
	return fs.readFileSync(path.join(cwd, ".pi", "registry.jsonc"), "utf8");
}

test("merge combines edits of different files; push, update and both projects converge", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const { remote, svc, a, b, run } = await fixture();
	fs.writeFileSync(skillFile(a.cwd, "notes.md"), "notes v2 from A\n");
	assert.equal((await run(a, { action: "push", type: "skill", name: "demo" })).error, undefined);
	fs.writeFileSync(skillFile(b.cwd, "SKILL.md"), SKILL_V1.replace("third section", "third section from B"));

	const diverged = await run(b, { action: "refresh" });
	assert.equal(item(diverged).status, "diverged");
	assert.deepEqual(item(diverged).actions.filter((action) => action === "merge" || action === "mark-merged"), ["merge", "mark-merged"]);
	const blockedPush = await run(b, { action: "push", type: "skill", name: "demo" });
	assert.match(blockedPush.error ?? "", /Run Merge/);
	const blockedUpdate = await run(b, { action: "update", type: "skill", name: "demo" });
	assert.match(blockedUpdate.error ?? "", /Run Merge/);

	const preview = await svc.diff({ cwd: b.cwd, mode: "merge", type: "skill", name: "demo" });
	assert.deepEqual(preview.files.map((file) => [file.path, file.newText, file.conflict]), [["skills/demo/notes.md", "notes v2 from A\n", undefined]]);
	assert.equal(fs.readFileSync(skillFile(b.cwd, "notes.md"), "utf8"), "notes v1\n", "preview writes nothing");

	const merged = await run(b, { action: "merge", type: "skill", name: "demo" });
	assert.equal(merged.error, undefined);
	assert.equal(item(merged).status, "local-changes");
	assert.equal(fs.readFileSync(skillFile(b.cwd, "notes.md"), "utf8"), "notes v2 from A\n");
	assert.match(fs.readFileSync(skillFile(b.cwd, "SKILL.md"), "utf8"), /third section from B/);

	const pushed = await run(b, { action: "push", type: "skill", name: "demo" });
	assert.equal(pushed.error, undefined);
	assert.equal(item(pushed).status, "up-to-date");
	assert.equal(item(await run(a, { action: "refresh" })).status, "update-available");
	assert.equal(item(await run(a, { action: "update", type: "skill", name: "demo" })).status, "up-to-date");
	assert.equal(item(await run(b, { action: "refresh" })).status, "up-to-date");
	for (const file of ["SKILL.md", "notes.md"]) {
		assert.equal(fs.readFileSync(skillFile(a.cwd, file), "utf8"), fs.readFileSync(skillFile(b.cwd, file), "utf8"));
		assert.equal(fs.readFileSync(skillFile(a.cwd, file), "utf8"), registryFile(remote, file));
	}
	const hashOf = (cwd: string) => /"hash":\s*"([0-9a-f]+)"/.exec(provenance(cwd))?.[1];
	assert.ok(hashOf(a.cwd));
	assert.equal(hashOf(a.cwd), hashOf(b.cwd));
});

test("merge auto-merges separate hunks of one file and refuses overlapping edits without writing", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const { svc, a, b, run } = await fixture();
	fs.writeFileSync(skillFile(a.cwd, "SKILL.md"), SKILL_V1.replace("first section", "first section from A"));
	assert.equal((await run(a, { action: "push", type: "skill", name: "demo" })).error, undefined);
	fs.writeFileSync(skillFile(b.cwd, "SKILL.md"), SKILL_V1.replace("third section", "third section from B"));
	const merged = await run(b, { action: "merge", type: "skill", name: "demo" });
	assert.equal(merged.error, undefined);
	const combined = fs.readFileSync(skillFile(b.cwd, "SKILL.md"), "utf8");
	assert.match(combined, /first section from A/);
	assert.match(combined, /third section from B/);
	assert.equal(item(merged).status, "local-changes");
	assert.equal((await run(b, { action: "push", type: "skill", name: "demo" })).error, undefined);

	// Now both sides rewrite the same line.
	assert.equal(item(await run(a, { action: "update", type: "skill", name: "demo" })).status, "up-to-date");
	fs.writeFileSync(skillFile(a.cwd, "SKILL.md"), combined.replace("second section", "second section by A"));
	fs.writeFileSync(skillFile(a.cwd, "notes.md"), "notes from A\n");
	assert.equal((await run(a, { action: "push", type: "skill", name: "demo" })).error, undefined);
	const localSkill = combined.replace("second section", "second section by B");
	fs.writeFileSync(skillFile(b.cwd, "SKILL.md"), localSkill);
	const baseline = provenance(b.cwd);

	const preview = await svc.diff({ cwd: b.cwd, mode: "merge", type: "skill", name: "demo" });
	assert.deepEqual(preview.files.filter((file) => file.conflict).map((file) => file.path), ["skills/demo/SKILL.md"]);
	const conflict = await run(b, { action: "merge", type: "skill", name: "demo" });
	assert.match(conflict.error ?? "", /1 conflicting file\(s\): skills\/demo\/SKILL\.md.*No files were written/);
	assert.equal(fs.readFileSync(skillFile(b.cwd, "SKILL.md"), "utf8"), localSkill);
	assert.equal(fs.readFileSync(skillFile(b.cwd, "notes.md"), "utf8"), "notes v1\n", "clean one-sided change is not applied either");
	assert.equal(provenance(b.cwd), baseline);
	assert.equal(item(conflict).status, "diverged");

	// Explicitly requested markers write clean changes plus markers, but keep the baseline.
	const marked = await run(b, { action: "merge", type: "skill", name: "demo", writeConflictMarkers: true });
	assert.equal(marked.error, undefined);
	assert.match(fs.readFileSync(skillFile(b.cwd, "SKILL.md"), "utf8"), /^<{7} local$[\s\S]*^>{7} registry$/m);
	assert.equal(fs.readFileSync(skillFile(b.cwd, "notes.md"), "utf8"), "notes from A\n");
	assert.equal(provenance(b.cwd), baseline);
	const refused = await run(b, { action: "mark-merged", type: "skill", name: "demo" });
	assert.match(refused.error ?? "", /Unresolved merge conflict markers remain in skills\/demo\/SKILL\.md/);
	assert.equal(provenance(b.cwd), baseline);
});

test("Mark as merged adopts the registry baseline after a manual merge and push publishes the local copy", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const { remote, svc, a, b, run } = await fixture();
	fs.writeFileSync(skillFile(a.cwd, "notes.md"), "notes v2 from A\n");
	assert.equal((await run(a, { action: "push", type: "skill", name: "demo" })).error, undefined);
	fs.mkdirSync(path.join(b.cwd, ".pi", "skills", "demo", "references"), { recursive: true });
	fs.writeFileSync(skillFile(b.cwd, "references/new.md"), "B reference\n");
	// Manual port of the registry change, as in the reported case.
	fs.writeFileSync(skillFile(b.cwd, "notes.md"), "notes v2 from A\n");
	const before = await run(b, { action: "refresh" });
	assert.equal(item(before).status, "diverged");
	assert.match((await run(b, { action: "push", type: "skill", name: "demo" })).error ?? "", /Mark as merged/);

	const review = await svc.diff({ cwd: b.cwd, mode: "compare", type: "skill", name: "demo" });
	assert.deepEqual(review.files.map((file) => file.path), ["skills/demo/references/new.md"], "registry → local shows no lost registry change");

	const adopted = await run(b, { action: "mark-merged", type: "skill", name: "demo" });
	assert.equal(adopted.error, undefined);
	assert.equal(item(adopted).status, "local-changes");
	assert.equal(fs.readFileSync(skillFile(b.cwd, "references/new.md"), "utf8"), "B reference\n", "local files are kept");
	const pushed = await run(b, { action: "push", type: "skill", name: "demo" });
	assert.equal(pushed.error, undefined);
	assert.equal(item(pushed).status, "up-to-date");
	for (const file of ["SKILL.md", "notes.md", "references/new.md"]) {
		assert.equal(registryFile(remote, file), fs.readFileSync(skillFile(b.cwd, file), "utf8"));
	}
});

test("merge actions refuse copies that are not diverged", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const { b, run } = await fixture();
	fs.writeFileSync(skillFile(b.cwd, "notes.md"), "local only edit\n");
	assert.equal(item(await run(b, { action: "refresh" })).status, "local-changes");
	assert.match((await run(b, { action: "merge", type: "skill", name: "demo" })).error ?? "", /has not changed in the registry; use Push/);
	assert.match((await run(b, { action: "mark-merged", type: "skill", name: "demo" })).error ?? "", /has not changed in the registry; use Push/);
});

test("project plans merge three ways and tasks offer only Mark as merged", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const { a, b, run } = await fixture();
	process.env.PI_RESOURCE_REGISTRY_PROJECT_KEY = "alpha";
	const plan = (cwd: string, file: string) => path.join(cwd, ".pi", "plans", file);
	fs.mkdirSync(path.join(a.cwd, ".pi", "plans"), { recursive: true });
	fs.writeFileSync(plan(a.cwd, "roadmap.md"), "roadmap v1\n");
	fs.writeFileSync(plan(a.cwd, "other.md"), "other v1\n");
	assert.equal((await run(a, { action: "push-project", scope: "plans" })).error, undefined);
	assert.equal((await run(b, { action: "pull-project", scope: "plans" })).error, undefined);
	assert.equal(fs.readFileSync(plan(b.cwd, "roadmap.md"), "utf8"), "roadmap v1\n");

	fs.writeFileSync(plan(a.cwd, "roadmap.md"), "roadmap v2 from A\n");
	assert.equal((await run(a, { action: "push-project", scope: "plans" })).error, undefined);
	fs.writeFileSync(plan(b.cwd, "other.md"), "other v2 from B\n");
	const diverged = await run(b, { action: "refresh" });
	assert.equal(item(diverged, "project:plans").status, "diverged");
	assert.deepEqual(item(diverged, "project:plans").actions, ["merge", "mark-merged"]);
	assert.match((await run(b, { action: "push-project", scope: "plans" })).error ?? "", /Run Merge/);

	const merged = await run(b, { action: "merge-project", scope: "plans" });
	assert.equal(merged.error, undefined);
	assert.equal(item(merged, "project:plans").status, "local-changes");
	assert.equal(fs.readFileSync(plan(b.cwd, "roadmap.md"), "utf8"), "roadmap v2 from A\n");
	assert.equal(fs.readFileSync(plan(b.cwd, "other.md"), "utf8"), "other v2 from B\n");
	assert.equal((await run(b, { action: "push-project", scope: "plans" })).error, undefined);
	assert.equal(item(await run(a, { action: "refresh" }), "project:plans").status, "update-available");
});
