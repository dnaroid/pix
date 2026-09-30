import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

import type { RegistryContext, RegistryExecutor } from "../src/registry/context.js";
import { registryExecutor } from "../src/registry/executor.js";
import { DesktopRegistryService } from "../src/registry/service.js";
import { loadRuntimeConfig, saveRegistryConfig } from "../src/registry/config.js";
import { loadRegistryConfig } from "../src/registry/config-reader.js";
import { projectKeyFromGitRemote } from "../src/registry/paths.js";
import { collectRegistryUiSnapshot } from "../src/registry/status.js";
import type { RegistryUiItem, RegistryUiSnapshot } from "../src/registry/model.js";

// Real Git/filesystem scenarios spawn many processes. This is a deadlock
// ceiling, not a performance assertion or a production command timeout.
const GIT_INTEGRATION_TIMEOUT_MS = 30_000;

const ENV_KEYS = [
	"HOME",
	"XDG_CACHE_HOME",
	"PI_CONFIG_DIR",
	"PI_RESOURCE_REGISTRY_REMOTE",
	"PI_RESOURCE_REGISTRY_BRANCH",
	"PI_RESOURCE_REGISTRY_PROJECT_KEY",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
] as const;

const originalEnv: Record<string, string | undefined> = {};
const roots: string[] = [];

beforeEach(() => {
	for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-registry-test-"));
	roots.push(root);
	return root;
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Registry Test",
			GIT_AUTHOR_EMAIL: "registry@example.test",
			GIT_COMMITTER_NAME: "Registry Test",
			GIT_COMMITTER_EMAIL: "registry@example.test",
		},
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
	return (result.stdout ?? "").trim();
}

function createRegistry(root: string): { remote: string; seed: string } {
	const seed = path.join(root, "seed");
	const remote = path.join(root, "registry.git");
	fs.mkdirSync(path.join(seed, "skills", "demo"), { recursive: true });
	fs.mkdirSync(path.join(seed, "agents"), { recursive: true });
	fs.writeFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "---\ndescription: Demo skill\n---\n\nv1\n");
	fs.writeFileSync(path.join(seed, "agents", "reviewer.md"), "---\ndescription: Review code\nmodels: [test/model]\n---\n\nReview carefully.\n");
	git(seed, ["init"]);
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "Initial resources"]);
	git(seed, ["branch", "-M", "main"]);
	git(root, ["init", "--bare", remote]);
	git(seed, ["remote", "add", "origin", remote]);
	git(seed, ["push", "-u", "origin", "main"]);
	return { remote, seed };
}

/** Isolated HOME/config/cache plus Git identity for spawned processes. */
function isolate(root: string): { home: string; cache: string } {
	const home = path.join(root, "home");
	const cache = path.join(root, "cache");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(cache, { recursive: true });
	process.env.HOME = home;
	process.env.XDG_CACHE_HOME = cache;
	delete process.env.PI_CONFIG_DIR;
	delete process.env.PI_RESOURCE_REGISTRY_REMOTE;
	delete process.env.PI_RESOURCE_REGISTRY_BRANCH;
	delete process.env.PI_RESOURCE_REGISTRY_PROJECT_KEY;
	process.env.GIT_AUTHOR_NAME = "Registry Test";
	process.env.GIT_AUTHOR_EMAIL = "registry@example.test";
	process.env.GIT_COMMITTER_NAME = "Registry Test";
	process.env.GIT_COMMITTER_EMAIL = "registry@example.test";
	return { home, cache };
}

type Notice = { message: string; type?: string };

/** Desktop dialog context with injectable confirm/input/editor and recorded notices. */
function harness(cwd: string): {
	ctx: RegistryContext;
	notices: Notice[];
	prompts: Array<{ title: string; prefill?: string }>;
	confirmations: Array<{ title: string; message: string }>;
	setConfirm(impl: (title: string, message: string) => Promise<boolean>): void;
	setInput(impl: (title: string, prefill?: string) => Promise<string | undefined>): void;
	setEditor(impl: (title: string, prefill?: string) => Promise<string | undefined>): void;
} {
	const notices: Notice[] = [];
	const prompts: Array<{ title: string; prefill?: string }> = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	let confirmImpl: (title: string, message: string) => Promise<boolean> = async () => true;
	let inputImpl: (title: string, prefill?: string) => Promise<string | undefined> = async () => undefined;
	let editorImpl: (title: string, prefill?: string) => Promise<string | undefined> = async () => undefined;
	const ctx: RegistryContext = {
		cwd,
		hasUI: true,
		ui: {
			confirm: async (title, message) => {
				confirmations.push({ title, message });
				return confirmImpl(title, message);
			},
			input: async (title, prefill) => {
				prompts.push({ title, prefill });
				return inputImpl(title, prefill);
			},
			editor: async (title, prefill) => editorImpl(title, prefill),
			notify: (message, type) => notices.push({ message, type }),
		},
	};
	return {
		ctx,
		notices,
		prompts,
		confirmations,
		setConfirm: (impl) => { confirmImpl = impl; },
		setInput: (impl) => { inputImpl = impl; },
		setEditor: (impl) => { editorImpl = impl; },
	};
}

const service = () => new DesktopRegistryService();

async function scopeFixture() {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	await saveRegistryConfig(remote, "main");
	process.env.PI_RESOURCE_REGISTRY_PROJECT_KEY = "alpha";
	return { root, project, remote, seed, h: harness(project) };
}

function act(cwd: string, request: Omit<Parameters<DesktopRegistryService["action"]>[0], "cwd">, ctx: RegistryContext, svc = service()) {
	return svc.action({ cwd, ...request }, ctx);
}

function item(snapshot: RegistryUiSnapshot, id: string): RegistryUiItem {
	const found = snapshot.items.find((entry) => entry.id === id);
	assert.ok(found, `snapshot item ${id} exists`);
	return found;
}

test("moves publication scope without publishing local edits, hides it from other projects, and syncs only scoped tags", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const { root, project, seed, h } = await scopeFixture();
	assert.equal((await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx)).error, undefined);
	const local = path.join(project, ".pi", "skills", "demo", "SKILL.md");
	fs.appendFileSync(local, "Private local body\n");
	const before = fs.readFileSync(local, "utf8");
	const moved = await act(project, { action: "toggle-scope", type: "skill", name: "demo" }, h.ctx);
	assert.equal(moved.error, undefined);
	assert.equal(item(moved, "skill:demo").publicationScope, "project");
	assert.equal(item(moved, "skill:demo").status, "local-changes");
	assert.equal(fs.readFileSync(local, "utf8"), before);
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	const scoped = path.join(seed, "projects", "alpha", "skills", "demo", "SKILL.md");
	assert.equal(fs.existsSync(path.join(seed, "skills", "demo")), false);
	assert.equal(fs.readFileSync(scoped, "utf8").includes("Private local body"), false);

	const other = path.join(root, "other");
	fs.mkdirSync(other);
	process.env.PI_RESOURCE_REGISTRY_PROJECT_KEY = "beta";
	const hidden = await act(other, { action: "refresh" }, harness(other).ctx);
	assert.equal(hidden.error, undefined);
	assert.equal(hidden.items.some((entry) => entry.id === "skill:demo"), false);
	process.env.PI_RESOURCE_REGISTRY_PROJECT_KEY = "alpha";
	h.setEditor(async () => "scoped, searchable");
	const tagged = await act(project, { action: "tags", type: "skill", name: "demo" }, h.ctx);
	assert.equal(tagged.error, undefined);
	assert.equal(item(tagged, "skill:demo").status, "local-changes");
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.match(fs.readFileSync(scoped, "utf8"), /scoped/);
	assert.equal(fs.readFileSync(scoped, "utf8").includes("Private local body"), false);

	const localAfterTags = fs.readFileSync(local, "utf8");
	const promoted = await act(project, { action: "toggle-scope", type: "skill", name: "demo" }, h.ctx);
	assert.equal(promoted.error, undefined);
	assert.equal(item(promoted, "skill:demo").publicationScope, "global");
	assert.equal(item(promoted, "skill:demo").status, "local-changes");
	assert.equal(fs.readFileSync(local, "utf8"), localAfterTags);
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.equal(fs.existsSync(scoped), false);
	assert.equal(fs.readFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "utf8").includes("Private local body"), false);
});

test("routes scoped body pushes and ignores incidental files during global promotion", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const { project, seed, h } = await scopeFixture();
	fs.mkdirSync(path.join(seed, "projects"), { recursive: true });
	fs.writeFileSync(path.join(seed, "projects", "README.md"), "Project namespaces\n");
	fs.writeFileSync(path.join(seed, "projects", ".DS_Store"), "incidental file");
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "Project namespace documentation"]);
	git(seed, ["push", "origin", "main"]);
	assert.equal((await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx)).error, undefined);
	assert.equal((await act(project, { action: "toggle-scope", type: "skill", name: "demo" }, h.ctx)).error, undefined);
	const local = path.join(project, ".pi", "skills", "demo", "SKILL.md");
	fs.appendFileSync(local, "Explicitly published body\n");
	const pushed = await act(project, { action: "push", type: "skill", name: "demo" }, h.ctx);
	assert.equal(pushed.error, undefined);
	assert.equal(item(pushed, "skill:demo").publicationScope, "project");
	assert.equal(item(pushed, "skill:demo").status, "up-to-date");
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	const scoped = path.join(seed, "projects", "alpha", "skills", "demo", "SKILL.md");
	assert.equal(fs.readFileSync(scoped, "utf8"), fs.readFileSync(local, "utf8"));
	assert.equal(fs.existsSync(path.join(seed, "skills", "demo")), false);
	const promoted = await act(project, { action: "toggle-scope", type: "skill", name: "demo" }, h.ctx);
	assert.equal(promoted.error, undefined);
	assert.equal(item(promoted, "skill:demo").publicationScope, "global");
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.equal(fs.readFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "utf8"), fs.readFileSync(local, "utf8"));
	assert.equal(fs.existsSync(scoped), false);
	assert.equal(fs.readFileSync(path.join(seed, "projects", "README.md"), "utf8"), "Project namespaces\n");
});

test("moves agent companions atomically and routes scoped install/update/diff/make-local", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const { project, seed, h } = await scopeFixture();
	const asset = path.join(seed, "agents", "reviewer", "rules.md");
	fs.mkdirSync(path.dirname(asset), { recursive: true });
	fs.writeFileSync(asset, "Published rules v1\n");
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "Agent companions"]);
	git(seed, ["push", "origin", "main"]);
	const moved = await act(project, { action: "toggle-scope", type: "agent", name: "reviewer" }, h.ctx);
	assert.equal(moved.error, undefined);
	assert.equal(item(moved, "agent:reviewer").status, "not-installed");
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	const remoteAsset = path.join(seed, "projects", "alpha", "agents", "reviewer", "rules.md");
	assert.equal(fs.readFileSync(remoteAsset, "utf8"), "Published rules v1\n");
	assert.equal(fs.existsSync(asset), false);
	assert.equal(fs.existsSync(path.join(seed, "agents", "reviewer.md")), false);
	assert.equal(git(seed, ["log", "-1", "--format=%s"]), "Move agent reviewer to project scope");

	assert.equal((await act(project, { action: "install", type: "agent", name: "reviewer" }, h.ctx)).error, undefined);
	const localAsset = path.join(project, ".pi", "agents", "reviewer", "rules.md");
	assert.equal(fs.readFileSync(localAsset, "utf8"), "Published rules v1\n");
	fs.writeFileSync(remoteAsset, "Published rules v2\n");
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "Scoped companion update"]);
	git(seed, ["push", "origin", "main"]);
	const updated = await act(project, { action: "update", type: "agent", name: "reviewer" }, h.ctx);
	assert.equal(updated.error, undefined);
	assert.equal(item(updated, "agent:reviewer").status, "up-to-date");
	assert.equal(fs.readFileSync(localAsset, "utf8"), "Published rules v2\n");
	fs.writeFileSync(localAsset, "Private rules\n");
	const diff = await service().diff({ cwd: project, type: "agent", name: "reviewer" });
	assert.equal(diff.error, undefined);
	assert.ok(JSON.stringify(diff).includes("Private rules"));
	const localized = await act(project, { action: "make-local", type: "agent", name: "reviewer" }, h.ctx);
	assert.equal(localized.error, undefined);
	assert.equal(item(localized, "agent:reviewer").remote, false);
	assert.equal(item(localized, "agent:reviewer").local, true);
	assert.equal(item(localized, "agent:reviewer").status, "local-only");
	assert.equal(fs.readFileSync(localAsset, "utf8"), "Private rules\n");
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.equal(fs.existsSync(remoteAsset), false);
	assert.equal(fs.existsSync(path.join(seed, "projects", "alpha", "agents", "reviewer.md")), false);
});

test("scope moves preserve a pending remote update and legacy global provenance", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const { project, seed, h } = await scopeFixture();
	await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx);
	const provenanceFile = path.join(project, ".pi", "registry.json");
	const provenance = JSON.parse(fs.readFileSync(provenanceFile, "utf8"));
	delete provenance.resources["skill:demo"].publicationScope;
	fs.writeFileSync(provenanceFile, JSON.stringify(provenance));
	fs.appendFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "Remote update\n");
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "Pending update"]);
	git(seed, ["push", "origin", "main"]);
	const moved = await act(project, { action: "toggle-scope", type: "skill", name: "demo" }, h.ctx);
	assert.equal(moved.error, undefined);
	assert.equal(item(moved, "skill:demo").status, "update-available");
	const updated = await act(project, { action: "update", type: "skill", name: "demo" }, h.ctx);
	assert.equal(updated.error, undefined);
	assert.equal(item(updated, "skill:demo").status, "up-to-date");
	assert.match(fs.readFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "utf8"), /Remote update/);
});

test("refuses global/project name collisions and global promotion or creation over another project", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const { project, seed, h } = await scopeFixture();
	const scoped = path.join(seed, "projects", "alpha", "skills", "demo");
	fs.mkdirSync(scoped, { recursive: true });
	fs.writeFileSync(path.join(scoped, "SKILL.md"), "---\ndescription: scoped\n---\nScoped bytes\n");
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "Conflicting namespace"]);
	git(seed, ["push", "origin", "main"]);
	const before = git(seed, ["rev-parse", "HEAD"]);
	const collision = await act(project, { action: "refresh" }, h.ctx);
	assert.match(collision.error ?? "", /collision/i);
	const refused = await act(project, { action: "toggle-scope", type: "skill", name: "demo" }, h.ctx);
	assert.match(refused.error ?? "", /collision/i);
	assert.equal(git(seed, ["ls-remote", "origin", "refs/heads/main"]).split(/\s/)[0], before);

	fs.rmSync(path.join(seed, "skills", "demo"), { recursive: true });
	const other = path.join(seed, "projects", "beta", "skills", "demo");
	fs.mkdirSync(other, { recursive: true });
	fs.writeFileSync(path.join(other, "SKILL.md"), "---\ndescription: other\n---\nOther project\n");
	git(seed, ["add", "-A"]);
	git(seed, ["commit", "-m", "Another project definition"]);
	git(seed, ["push", "origin", "main"]);
	const promotion = await act(project, { action: "toggle-scope", type: "skill", name: "demo" }, h.ctx);
	assert.match(promotion.error ?? "", /collision/i);
	process.env.PI_RESOURCE_REGISTRY_PROJECT_KEY = "gamma";
	const local = path.join(project, ".pi", "skills", "demo");
	fs.mkdirSync(local, { recursive: true });
	fs.writeFileSync(path.join(local, "SKILL.md"), "---\ndescription: private\n---\nLocal\n");
	const creation = await act(project, { action: "push", type: "skill", name: "demo" }, h.ctx);
	assert.match(creation.error ?? "", /collision/i);
	assert.equal(fs.existsSync(path.join(seed, "skills", "demo")), false);
});

test("scope toggle requires a project identity, supports cancel and rejects symlink namespace ancestors", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const { project, seed, h } = await scopeFixture();
	delete process.env.PI_RESOURCE_REGISTRY_PROJECT_KEY;
	const missingKey = await act(project, { action: "toggle-scope", type: "skill", name: "demo" }, h.ctx);
	assert.match(missingKey.error ?? "", /project key/i);
	process.env.PI_RESOURCE_REGISTRY_PROJECT_KEY = "alpha";
	h.setConfirm(async () => false);
	const cancelled = await act(project, { action: "toggle-scope", type: "skill", name: "demo" }, h.ctx);
	assert.equal(cancelled.error, undefined);
	assert.equal(item(cancelled, "skill:demo").publicationScope, "global");
	fs.symlinkSync("skills", path.join(seed, "projects"));
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "Symlink namespace"]);
	git(seed, ["push", "origin", "main"]);
	h.setConfirm(async () => true);
	const unsafe = await act(project, { action: "toggle-scope", type: "skill", name: "demo" }, h.ctx);
	assert.match(unsafe.error ?? "", /symbolic link/i);
	assert.equal(fs.existsSync(path.join(seed, "skills", "demo", "SKILL.md")), true);
});

test("background project sync is silent, excludes skills/agents, and refuses untracked overwrite", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const { remote } = createRegistry(root);
	const project = path.join(root, "project");
	fs.mkdirSync(path.join(project, ".pi", "plans"), { recursive: true });
	fs.mkdirSync(path.join(project, ".pi", "skills", "draft"), { recursive: true });
	fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(project, ".pi", "tasks.jsonc"), '{"version":1,"tasks":[]}\n');
	fs.writeFileSync(path.join(project, ".pi", "workspace.jsonc"), '{"version":1}\n');
	fs.writeFileSync(path.join(project, ".pi", "TODO.md"), "Task list\n");
	fs.writeFileSync(path.join(project, ".pi", "plans", "plan.md"), "Plan\n");
	fs.writeFileSync(path.join(project, ".pi", "skills", "draft", "SKILL.md"), "---\ndescription: Draft\n---\nDraft\n");
	fs.writeFileSync(path.join(project, ".pi", "agents", "draft.md"), "---\ndescription: Draft\nmodels: [test/model]\n---\nDraft\n");
	const h = harness(project);
	await saveRegistryConfig(remote, "main");
	h.setInput(async () => "background-project");
	await act(project, { action: "project-key" }, h.ctx);
	h.notices.length = 0;
	h.confirmations.length = 0;
	const snapshot = await act(project, { action: "sync-project", scope: "project" }, h.ctx);
	assert.equal(snapshot.error, undefined);
	assert.ok(snapshot.items.filter((entry) => entry.type === "project").every((entry) => entry.status === "up-to-date"));
	const files = git(root, ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]);
	for (const file of ["tasks.jsonc", "workspace.jsonc", "TODO.md", "plans/plan.md"]) {
		assert.ok(files.includes(`projects/background-project/${file}`), `registry tracks ${file}`);
	}
	assert.equal(files.includes("skills/draft"), false);
	assert.equal(files.includes("agents/draft"), false);
	assert.deepEqual(h.notices, []);
	assert.equal(h.confirmations.length, 0);

	const other = path.join(root, "other");
	fs.mkdirSync(path.join(other, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(other, ".pi", "TODO.md"), "Unrelated local TODO\n");
	const second = harness(other);
	await saveRegistryConfig(remote, "main");
	second.setInput(async () => "background-project");
	await act(other, { action: "project-key" }, second.ctx);
	second.notices.length = 0;
	second.confirmations.length = 0;
	const refused = await act(other, { action: "sync-project", scope: "todo" }, second.ctx);
	assert.match(refused.error ?? "", /untracked remote state/);
	assert.deepEqual(second.notices, []);
	assert.equal(second.confirmations.length, 0);
	assert.equal(git(root, ["--git-dir", remote, "show", "main:projects/background-project/TODO.md"]), "Task list");
});

test("skills and agents publish tags and convert back to local without losing companions or other project copies", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	const { home } = isolate(root);
	const project = path.join(root, "project");
	const other = path.join(root, "other-project");
	for (const dir of [home, project, other]) fs.mkdirSync(dir, { recursive: true });
	const { remote, seed } = createRegistry(root);
	fs.mkdirSync(path.join(seed, "agents", "reviewer"), { recursive: true });
	fs.writeFileSync(path.join(seed, "agents", "reviewer", "guide.md"), "Companion");
	fs.writeFileSync(path.join(seed, "skills", "demo", "example.txt"), "Skill companion");
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "Companions"]);
	git(seed, ["push"]);
	const h = harness(project);
	const second = harness(other);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	for (const [type, name, relativeFile, companion] of [
		["skill", "demo", "skills/demo/SKILL.md", "skills/demo/example.txt"],
		["agent", "reviewer", "agents/reviewer.md", "agents/reviewer/guide.md"],
	] as const) {
		await act(other, { action: "install", type, name }, second.ctx);
		const otherSource = fs.readFileSync(path.join(other, ".pi", relativeFile), "utf8");
		const remoteSource = fs.readFileSync(path.join(seed, relativeFile), "utf8");
		h.setConfirm(async () => false);
		const cancelled = await act(project, { action: "make-local", type, name }, h.ctx);
		assert.match(cancelled.error ?? "", /cancelled/);
		assert.equal(fs.existsSync(path.join(project, ".pi", relativeFile)), false);
		git(seed, ["pull", "--ff-only"]);
		assert.equal(fs.readFileSync(path.join(seed, relativeFile), "utf8"), remoteSource);
		h.setConfirm(async () => true);
		const madeLocal = await act(project, { action: "make-local", type, name }, h.ctx);
		assert.equal(madeLocal.error, undefined);
		assert.equal(fs.readFileSync(path.join(project, ".pi", relativeFile), "utf8"), remoteSource);
		assert.equal(fs.existsSync(path.join(project, ".pi", companion)), true);
		assert.equal(fs.readFileSync(path.join(other, ".pi", relativeFile), "utf8"), otherSource);
		assert.equal(item(madeLocal, `${type}:${name}`).local, true);
		assert.equal(item(madeLocal, `${type}:${name}`).remote, false);
		h.setEditor(async () => "quality, security");
		const tagged = await act(project, { action: "tags", type, name }, h.ctx);
		assert.deepEqual(item(tagged, `${type}:${name}`).tags, ["quality", "security"]);
		await act(project, { action: "push", type, name }, h.ctx);
		git(seed, ["pull", "--ff-only"]);
		assert.match(fs.readFileSync(path.join(seed, relativeFile), "utf8"), /tags: \["quality","security"\]/);
		assert.equal(fs.existsSync(path.join(seed, companion)), true);
		const localFile = path.join(project, ".pi", relativeFile);
		fs.appendFileSync(localFile, "\nLocal work preserved\n");
		const madeLocalAgain = await act(project, { action: "make-local", type, name }, h.ctx);
		assert.equal(madeLocalAgain.error, undefined);
		assert.match(fs.readFileSync(localFile, "utf8"), /Local work preserved/);
		git(seed, ["pull", "--ff-only"]);
		assert.equal(fs.existsSync(path.join(seed, relativeFile)), false);
		assert.equal(fs.existsSync(path.join(seed, companion)), false);
	}
});

test("make-local refuses to unpublish when the remote-only agent cannot be installed", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	const { home } = isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	fs.writeFileSync(path.join(seed, "agents", "reviewer.md"), "---\nunknownSetting: true\n---\nInvalid");
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "Invalid agent"]);
	git(seed, ["push"]);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	const snapshot = await act(project, { action: "make-local", type: "agent", name: "reviewer" }, h.ctx);
	assert.match(snapshot.error ?? "", /valid .*agents Markdown definition|must be a valid/);
	git(seed, ["pull", "--ff-only"]);
	assert.equal(fs.existsSync(path.join(seed, "agents", "reviewer.md")), true);
	assert.equal(fs.existsSync(path.join(project, ".pi", "agents", "reviewer.md")), false);
});

test("make-local preserves publication and local work when an existing project copy is incomplete or invalid", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	const { home } = isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	const skill = path.join(project, ".pi", "skills", "demo");
	const agent = path.join(project, ".pi", "agents", "reviewer.md");
	fs.mkdirSync(skill, { recursive: true });
	fs.writeFileSync(path.join(skill, "local-work.txt"), "Keep incomplete skill work");
	fs.mkdirSync(path.dirname(agent), { recursive: true });
	const invalidAgent = "---\nunknownSetting: true\n---\nKeep invalid agent work";
	fs.writeFileSync(agent, invalidAgent);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	for (const [type, name, relativeFile] of [
		["skill", "demo", "skills/demo/SKILL.md"],
		["agent", "reviewer", "agents/reviewer.md"],
	] as const) {
		const remoteSource = fs.readFileSync(path.join(seed, relativeFile), "utf8");
		const snapshot = await act(project, { action: "make-local", type, name }, h.ctx);
		assert.ok(snapshot.error, `${type} make-local refuses`);
		git(seed, ["pull", "--ff-only"]);
		assert.equal(fs.readFileSync(path.join(seed, relativeFile), "utf8"), remoteSource);
	}
	assert.equal(fs.existsSync(path.join(skill, "SKILL.md")), false);
	assert.equal(fs.readFileSync(path.join(skill, "local-work.txt"), "utf8"), "Keep incomplete skill work");
	assert.equal(fs.readFileSync(agent, "utf8"), invalidAgent);
});

test("derives the same project key from SSH and HTTPS GitHub remotes", () => {
	assert.equal(projectKeyFromGitRemote("git@github.com:dnaroid/pi-ui-extend.git"), "github.com__dnaroid__pi-ui-extend");
	assert.equal(projectKeyFromGitRemote("https://github.com/dnaroid/pi-ui-extend.git"), "github.com__dnaroid__pi-ui-extend");
});

test("publishes installed local resources before a Marketplace remote is configured", async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(path.join(project, ".pi", "skills", "local-skill"), { recursive: true });
	fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "skills", "local-skill", "SKILL.md"),
		"---\ndescription: Local skill\n---\n\nLocal skill body.\n",
	);
	fs.writeFileSync(
		path.join(project, ".pi", "agents", "local-agent.md"),
		"---\ndescription: Local agent\nmodels: [test/model]\n---\n\nLocal agent body.\n",
	);
	const snapshot = await service().action({ cwd: project, action: "refresh" }, harness(project).ctx);
	assert.equal(snapshot.configured, false);
	assert.equal(snapshot.remote, undefined);
	assert.deepEqual(snapshot.items.map((entry) => entry.id), ["agent:local-agent", "skill:local-skill"]);
	for (const entry of snapshot.items) {
		assert.equal(entry.status, "local-only");
		assert.equal(entry.local, true);
		assert.equal(entry.remote, false);
		assert.deepEqual(entry.actions, ["tags", "uninstall"]);
	}
});

test("a project without Git origin keeps reusable Registry resources usable and asks only for a project key", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "plain-project");
	fs.mkdirSync(project, { recursive: true });
	const { remote } = createRegistry(root);
	await saveRegistryConfig(remote, "main");
	const snapshot = await service().action({ cwd: project, action: "refresh" }, harness(project).ctx);
	assert.equal(snapshot.configured, true);
	assert.equal(snapshot.projectKey, undefined);
	assert.match(snapshot.projectIssue ?? "", /Project state needs a registry key/);
	assert.equal(snapshot.error, undefined);
	assert.ok(snapshot.items.some((entry) => entry.type === "skill" && entry.name === "demo"));

	const afterProjectActionFailure = await collectRegistryUiSnapshot(registryExecutor, project, snapshot.projectIssue);
	assert.equal(afterProjectActionFailure.projectIssue, snapshot.projectIssue);
	assert.equal(afterProjectActionFailure.error, undefined);
});

test("interactive remote setup prompts for remote and branch and cancelling saves nothing", async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const h = harness(project);
	h.setInput(async () => undefined);
	await act(project, { action: "configure" }, h.ctx);
	assert.deepEqual(h.prompts.map((prompt) => prompt.title), ["Registry Git remote"]);
	assert.equal(loadRegistryConfig(project).remote, undefined);

	const { remote } = createRegistry(root);
	const answers = [remote, "main"];
	h.setInput(async () => answers.shift());
	const snapshot = await act(project, { action: "configure" }, h.ctx);
	assert.deepEqual(h.prompts.map((prompt) => prompt.title), ["Registry Git remote", "Registry Git remote", "Registry branch"]);
	assert.equal(snapshot.configured, true);
	const savedConfig = JSON.parse(
		fs.readFileSync(path.join(process.env.HOME!, ".config", "pi", "pi-tools-suite.jsonc"), "utf8"),
	);
	assert.deepEqual(savedConfig.resourceRegistry, { remote, branch: "main" });
});

test("the default async Node Git executor bounds spawned commands and identifies timeouts", async () => {
	const root = tempRoot();
	const cwd = fs.mkdirSync(path.join(root, "cwd"), { recursive: true });
	const version = await registryExecutor.exec("git", ["--version"], { cwd, timeout: 10_000 });
	assert.equal(version.code, 0);
	assert.match(version.stdout, /git version/);
	const command = [process.execPath, "-e", "setTimeout(() => {}, 60_000)"];
	await assert.rejects(
		registryExecutor.exec(command[0], command.slice(1), { cwd, timeout: 60 }),
		(error: Error & { killed?: boolean }) => error.killed === true || error.message.includes("60"),
	);
});

test("reports an actionable error for a configured local registry that no longer exists", () => {
	const root = tempRoot();
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	fs.mkdirSync(path.join(home, ".config", "pi"), { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	process.env.HOME = home;
	const missingRemote = path.join(root, "deleted-registry.git");
	fs.writeFileSync(
		path.join(home, ".config", "pi", "pi-tools-suite.jsonc"),
		JSON.stringify({ resourceRegistry: { remote: missingRemote, branch: "main" } }),
	);
	assert.throws(() => loadRuntimeConfig(project), (error: Error) =>
		error.message.includes(`Configured resource registry remote does not exist: ${missingRemote}`)
		&& error.message.includes("Configure the Git remote in Desktop Registry"));
});

test("publishes structured registry snapshots for the Desktop manager", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	const { home } = isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);

	const refreshed = await act(project, { action: "refresh" }, h.ctx);
	assert.equal(refreshed.configured, true);
	assert.equal(refreshed.remote, remote);
	assert.equal(refreshed.branch, "main");
	const notInstalled = item(refreshed, "skill:demo");
	assert.equal(notInstalled.status, "not-installed");
	assert.equal(notInstalled.statusLabel, "NOT INSTALLED");
	assert.equal(notInstalled.local, false);
	assert.equal(notInstalled.remote, true);
	assert.deepEqual(notInstalled.actions, ["install", "toggle-scope", "make-local", "remove"]);

	const installed = await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx);
	const upToDate = item(installed, "skill:demo");
	assert.equal(upToDate.status, "up-to-date");
	assert.equal(upToDate.statusLabel, "UP TO DATE");
	assert.equal(upToDate.local, true);
	assert.equal(upToDate.remote, true);
	assert.deepEqual(upToDate.actions, ["tags", "uninstall", "toggle-scope", "make-local", "remove"]);

	fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "agents", "architect.md"),
		"---\ndescription: Architecture review\nmodels: [test/model]\n---\n\nReview architecture.\n",
	);
	const pushed = await act(project, { action: "push", type: "agent", name: "architect" }, h.ctx);
	assert.equal(item(pushed, "agent:architect").status, "up-to-date");
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.match(fs.readFileSync(path.join(seed, "agents", "architect.md"), "utf8"), /Architecture review/);
});

test("serializes concurrent service calls on the shared checkout cache", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote } = createRegistry(root);
	await saveRegistryConfig(remote, "main");
	const h = harness(project);
	let active = 0;
	let maxActive = 0;
	const counting: RegistryExecutor = {
		exec: async (command, args, options) => {
			// Project-key Git reads may run in parallel. Only shared checkout
			// access must be serialized; project reads cannot mutate the cache.
			const checkoutAccess = options?.cwd !== project;
			if (checkoutAccess) {
				active += 1;
				maxActive = Math.max(maxActive, active);
			}
			try {
				return await registryExecutor.exec(command, args, options);
			} finally {
				if (checkoutAccess) active -= 1;
			}
		},
	};
	const svc = new DesktopRegistryService(counting);
	const snapshots = await Promise.all([
		svc.action({ cwd: project, action: "refresh" }, h.ctx),
		svc.action({ cwd: project, action: "refresh" }, h.ctx),
		svc.action({ cwd: project, action: "refresh" }, h.ctx),
	]);
	assert.equal(maxActive, 1);
	assert.ok(snapshots.every((snapshot) => snapshot.configured === true && snapshot.error === undefined));
});

test("tag editing does not hold the checkout lock and syncs published tag edits", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	const h = harness(project);
	const svc = service();
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx, svc);
	await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx, svc);
	const localSkill = path.join(project, ".pi", "skills", "demo", "SKILL.md");
	fs.appendFileSync(localSkill, "\nUnpublished local instructions\n");
	fs.writeFileSync(path.join(project, ".pi", "skills", "demo", "private.txt"), "Local-only asset");
	let refreshDuringEditor: Promise<RegistryUiSnapshot> | undefined;
	h.setEditor(async () => {
		// A background refresh must complete while the editor is open; the
		// editor must not hold the checkout lock (deadlock ceiling above).
		refreshDuringEditor = svc.action({ cwd: project, action: "refresh" }, h.ctx);
		await refreshDuringEditor;
		return "solo";
	});
	const snapshot = await act(project, { action: "tags", type: "skill", name: "demo" }, h.ctx, svc);
	assert.equal(snapshot.error, undefined);
	const refreshed = await refreshDuringEditor!;
	assert.equal(refreshed.error, undefined);
	assert.deepEqual(item(snapshot, "skill:demo").tags, ["solo"]);
	assert.equal(item(snapshot, "skill:demo").status, "local-changes");
	git(seed, ["pull", "--ff-only"]);
	const published = fs.readFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "utf8");
	assert.match(published, /tags: \["solo"\]/);
	assert.equal(published.includes("Unpublished local instructions"), false);
	assert.equal(fs.existsSync(path.join(seed, "skills", "demo", "private.txt")), false);
});

test("published agent tag sync leaves unrelated local prompt and companions unpublished", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	await saveRegistryConfig(remote, "main");
	const h = harness(project);
	await act(project, { action: "install", type: "agent", name: "reviewer" }, h.ctx);
	const agent = path.join(project, ".pi", "agents", "reviewer.md");
	fs.appendFileSync(agent, "\nLocal prompt change\n");
	fs.mkdirSync(path.join(project, ".pi", "agents", "reviewer"));
	fs.writeFileSync(path.join(project, ".pi", "agents", "reviewer", "private.txt"), "Private context");
	h.setEditor(async () => "review");
	const snapshot = await act(project, { action: "tags", type: "agent", name: "reviewer" }, h.ctx);
	assert.equal(snapshot.error, undefined);
	assert.equal(item(snapshot, "agent:reviewer").status, "local-changes");
	git(seed, ["pull", "--ff-only"]);
	const published = fs.readFileSync(path.join(seed, "agents", "reviewer.md"), "utf8");
	assert.match(published, /tags: \["review"\]/);
	assert.equal(published.includes("Local prompt change"), false);
	assert.equal(fs.existsSync(path.join(seed, "agents", "reviewer", "private.txt")), false);
});

test("tag editor saves locally even when registry publication lookup fails", async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(path.join(project, ".pi", "skills", "draft"), { recursive: true });
	const file = path.join(project, ".pi", "skills", "draft", "SKILL.md");
	fs.writeFileSync(file, "---\ndescription: Draft\n---\nBody\n");
	await saveRegistryConfig("https://example.invalid/registry.git", "main");
	const h = harness(project);
	h.setEditor(async () => "offline");
	const svc = new DesktopRegistryService({ exec: async () => { throw new Error("Git unavailable"); } });
	const snapshot = await act(project, { action: "tags", type: "skill", name: "draft" }, h.ctx, svc);
	assert.match(snapshot.error ?? "", /Tags saved locally; could not verify publication/);
	assert.match(fs.readFileSync(file, "utf8"), /tags: \["offline"\]/);
});

test("tag editing on a publication that changed while editing keeps local tags and reports the conflict", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx);
	h.setEditor(async () => {
		fs.writeFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "---\ndescription: Demo skill\n---\n\nv2 remote edit\n");
		git(seed, ["add", "skills/demo/SKILL.md"]);
		git(seed, ["commit", "-m", "Concurrent publication"]);
		git(seed, ["push", "origin", "main"]);
		return "conflicting";
	});
	const snapshot = await act(project, { action: "tags", type: "skill", name: "demo" }, h.ctx);
	assert.match(snapshot.error ?? "", /publication changed while editing/);
	const local = fs.readFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "utf8");
	assert.match(local, /tags: \["conflicting"\]/);
	git(seed, ["pull", "--ff-only"]);
	assert.equal(fs.readFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "utf8").includes("conflicting"), false);
});

test("tag editing stays local when the resource is not published", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	// (a) No registry remote configured at all.
	const unconfigured = path.join(root, "unconfigured");
	fs.mkdirSync(path.join(unconfigured, ".pi", "skills", "draft"), { recursive: true });
	fs.writeFileSync(
		path.join(unconfigured, ".pi", "skills", "draft", "SKILL.md"),
		"---\ndescription: Draft\n---\nDraft body\n",
	);
	const first = harness(unconfigured);
	first.setEditor(async () => "offline");
	const localOnly = await act(unconfigured, { action: "tags", type: "skill", name: "draft" }, first.ctx);
	assert.equal(localOnly.configured, false);
	assert.equal(localOnly.error, undefined);
	assert.match(
		fs.readFileSync(path.join(unconfigured, ".pi", "skills", "draft", "SKILL.md"), "utf8"),
		/tags: \["offline"\]/,
	);

	// (b) Registry configured, but this skill exists only locally.
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	fs.mkdirSync(path.join(project, ".pi", "skills", "draft"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "skills", "draft", "SKILL.md"),
		"---\ndescription: Draft\n---\nDraft body\n",
	);
	h.setEditor(async () => "unpublished");
	const snapshot = await act(project, { action: "tags", type: "skill", name: "draft" }, h.ctx);
	assert.equal(snapshot.error, undefined);
	const draft = item(snapshot, "skill:draft");
	assert.equal(draft.status, "local-only");
	assert.equal(draft.remote, false);
	assert.deepEqual(draft.tags, ["unpublished"]);
	git(seed, ["pull", "--ff-only"]);
	assert.equal(fs.existsSync(path.join(seed, "skills", "draft")), false);
});

test("cancelling the tag editor leaves the published resource untouched", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx);
	const before = fs.readFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "utf8");
	h.setEditor(async () => undefined);
	const snapshot = await act(project, { action: "tags", type: "skill", name: "demo" }, h.ctx);
	assert.match(snapshot.error ?? "", /cancelled/);
	assert.equal(fs.readFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "utf8"), before);
	git(seed, ["pull", "--ff-only"]);
	assert.equal(fs.readFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "utf8"), "v1\n" in {} ? "" : fs.readFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "utf8"));
});

test("installs, detects updates, updates, and pushes skills/agents through Git", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	const { home } = isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx);
	await act(project, { action: "install", type: "agent", name: "reviewer" }, h.ctx);

	assert.match(fs.readFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "utf8"), /v1/);
	assert.match(fs.readFileSync(path.join(project, ".pi", "agents", "reviewer.md"), "utf8"), /Review carefully/);
	assert.equal(fs.existsSync(path.join(project, ".pi", "registry.json")), true);

	fs.writeFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "---\ndescription: Demo skill\n---\n\nv2\n");
	git(seed, ["add", "skills/demo/SKILL.md"]);
	git(seed, ["commit", "-m", "Update demo"]);
	git(seed, ["push", "origin", "main"]);

	const status = await act(project, { action: "refresh" }, h.ctx);
	assert.equal(item(status, "skill:demo").status, "update-available");
	assert.equal(item(status, "agent:reviewer").status, "up-to-date");

	await act(project, { action: "update", type: "skill", name: "demo" }, h.ctx);
	assert.match(fs.readFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "utf8"), /v2/);

	fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "agents", "architect.md"),
		"---\ndescription: Architecture review\nmodels: [test/model]\n---\n\nReview architecture.\n",
	);
	await act(project, { action: "push", type: "agent", name: "architect" }, h.ctx);
	assert.match(git(seed, ["pull", "--ff-only", "origin", "main"]), /Updating/);
	assert.match(fs.readFileSync(path.join(seed, "agents", "architect.md"), "utf8"), /Architecture review/);
	assert.match(h.notices.at(-1)?.message ?? "", /Pushed agent "architect"/);
});

test("syncs an agent's same-named companion directory across its full lifecycle", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	const remoteDir = path.join(seed, "agents", "reviewer");
	fs.mkdirSync(path.join(remoteDir, "guides"), { recursive: true });
	fs.writeFileSync(path.join(remoteDir, "guides", "review.md"), "first guide");
	git(seed, ["add", "agents/reviewer"]);
	git(seed, ["commit", "-m", "Add reviewer assets"]);
	git(seed, ["push", "origin", "main"]);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	await act(project, { action: "install", type: "agent", name: "reviewer" }, h.ctx);
	const localDir = path.join(project, ".pi", "agents", "reviewer");
	const localGuide = path.join(localDir, "guides", "review.md");
	assert.equal(fs.readFileSync(localGuide, "utf8"), "first guide");

	fs.writeFileSync(localGuide, "local guide");
	let snapshot = await act(project, { action: "refresh" }, h.ctx);
	assert.equal(item(snapshot, "agent:reviewer").status, "local-changes");
	await act(project, { action: "push", type: "agent", name: "reviewer" }, h.ctx);
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.equal(fs.readFileSync(path.join(remoteDir, "guides", "review.md"), "utf8"), "local guide");

	fs.writeFileSync(path.join(remoteDir, "guides", "review.md"), "remote guide");
	git(seed, ["add", "agents/reviewer"]);
	git(seed, ["commit", "-m", "Update reviewer guide only"]);
	git(seed, ["push", "origin", "main"]);
	snapshot = await act(project, { action: "refresh" }, h.ctx);
	assert.equal(item(snapshot, "agent:reviewer").status, "update-available");
	await act(project, { action: "update", type: "agent", name: "reviewer" }, h.ctx);
	assert.equal(fs.readFileSync(localGuide, "utf8"), "remote guide");
	fs.rmSync(remoteDir, { recursive: true });
	git(seed, ["add", "-A", "agents/reviewer"]);
	git(seed, ["commit", "-m", "Remove reviewer assets only"]);
	git(seed, ["push", "origin", "main"]);
	snapshot = await act(project, { action: "refresh" }, h.ctx);
	assert.equal(item(snapshot, "agent:reviewer").status, "update-available");
	await act(project, { action: "update", type: "agent", name: "reviewer" }, h.ctx);
	assert.equal(fs.existsSync(localDir), false);

	fs.mkdirSync(path.join(localDir, "guides"), { recursive: true });
	fs.writeFileSync(localGuide, "local only");
	snapshot = await act(project, { action: "refresh" }, h.ctx);
	assert.equal(item(snapshot, "agent:reviewer").status, "local-changes");
	fs.rmSync(localDir, { recursive: true });
	await act(project, { action: "push", type: "agent", name: "reviewer" }, h.ctx);
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.equal(fs.existsSync(remoteDir), false);
	await act(project, { action: "uninstall", type: "agent", name: "reviewer" }, h.ctx);
	assert.equal(fs.existsSync(path.join(project, ".pi", "agents", "reviewer.md")), false);
	fs.mkdirSync(localDir, { recursive: true });
	fs.writeFileSync(path.join(project, ".pi", "agents", "reviewer.md"), "---\ndescription: Review code\nmodels: [test/model]\n---\n\nReview.\n");
	fs.writeFileSync(path.join(localDir, "asset.txt"), "asset");
	await act(project, { action: "push", type: "agent", name: "reviewer" }, h.ctx);
	await act(project, { action: "remove", type: "agent", name: "reviewer" }, h.ctx);
	assert.equal(fs.existsSync(localDir), true);
	await act(project, { action: "uninstall", type: "agent", name: "reviewer" }, h.ctx);
	assert.equal(fs.existsSync(localDir), false);
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.equal(fs.existsSync(remoteDir), false);
});

test("pushes, reports, and pulls project-scoped tasks, plans, TODO, and workspace state without mixing them with reusable resources", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(path.join(project, ".pi", "plans"), { recursive: true });
	const { remote, seed } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	h.setInput(async () => "project-alpha");
	await act(project, { action: "project-key" }, h.ctx);
	fs.writeFileSync(path.join(project, ".pi", "tasks.jsonc"), '// keep this comment\n{"tasks":["local-v1"],}\n');
	fs.writeFileSync(path.join(project, ".pi", "plans", "roadmap.md"), "local plan v1\n");
	fs.writeFileSync(path.join(project, ".pi", "TODO.md"), "# TODO\n\n- local todo v1\n");
	fs.writeFileSync(path.join(project, ".pi", "workspace.jsonc"), '{"workspace":"local-v1"}\n');

	await act(project, { action: "push-project", scope: "project" }, h.ctx);
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.match(fs.readFileSync(path.join(seed, "projects", "project-alpha", "tasks.jsonc"), "utf8"), /keep this comment/);
	assert.match(fs.readFileSync(path.join(seed, "projects", "project-alpha", "plans", "roadmap.md"), "utf8"), /local plan v1/);
	assert.match(fs.readFileSync(path.join(seed, "projects", "project-alpha", "TODO.md"), "utf8"), /local todo v1/);
	assert.match(fs.readFileSync(path.join(seed, "projects", "project-alpha", "workspace.jsonc"), "utf8"), /local-v1/);
	assert.equal(fs.existsSync(path.join(seed, "skills", "demo", "SKILL.md")), true);

	fs.writeFileSync(path.join(seed, "projects", "project-alpha", "tasks.jsonc"), '{"tasks":["remote-v2"]}\n');
	fs.writeFileSync(path.join(seed, "projects", "project-alpha", "plans", "roadmap.md"), "remote plan v2\n");
	fs.writeFileSync(path.join(seed, "projects", "project-alpha", "TODO.md"), "# TODO\n\n- remote todo v2\n");
	fs.writeFileSync(path.join(seed, "projects", "project-alpha", "workspace.jsonc"), '{"workspace":"remote-v2"}\n');
	git(seed, ["add", "projects/project-alpha"]);
	git(seed, ["commit", "-m", "Update project state"]);
	git(seed, ["push", "origin", "main"]);

	const updateStatus = await act(project, { action: "refresh" }, h.ctx);
	for (const artifact of ["tasks", "plans", "todo", "workspace"]) {
		assert.equal(item(updateStatus, `project:${artifact}`).status, "update-available", `${artifact} is outdated`);
	}

	await act(project, { action: "pull-project", scope: "project" }, h.ctx);
	assert.match(fs.readFileSync(path.join(project, ".pi", "tasks.jsonc"), "utf8"), /remote-v2/);
	assert.match(fs.readFileSync(path.join(project, ".pi", "plans", "roadmap.md"), "utf8"), /remote plan v2/);
	assert.match(fs.readFileSync(path.join(project, ".pi", "TODO.md"), "utf8"), /remote todo v2/);
	assert.match(fs.readFileSync(path.join(project, ".pi", "workspace.jsonc"), "utf8"), /remote-v2/);

	const localWorkspace = path.join(project, ".pi", "workspace.jsonc");
	const remoteWorkspace = path.join(seed, "projects", "project-alpha", "workspace.jsonc");
	fs.writeFileSync(localWorkspace, '{"workspace":"local-diverged"}\n');
	fs.writeFileSync(remoteWorkspace, '{"workspace":"remote-diverged"}\n');
	git(seed, ["add", "projects/project-alpha/workspace.jsonc"]);
	git(seed, ["commit", "-m", "Diverge workspace state"]);
	git(seed, ["push", "origin", "main"]);

	const diverged = await act(project, { action: "refresh" }, h.ctx);
	assert.equal(item(diverged, "project:workspace").status, "diverged");
	const localBeforeConflictActions = fs.readFileSync(localWorkspace, "utf8");
	const remoteBeforeConflictActions = fs.readFileSync(remoteWorkspace, "utf8");
	const pushConflict = await act(project, { action: "push-project", scope: "workspace" }, h.ctx);
	assert.match(pushConflict.error ?? "", /changed in the registry/);
	assert.equal(fs.readFileSync(remoteWorkspace, "utf8"), remoteBeforeConflictActions);
	const pullConflict = await act(project, { action: "pull-project", scope: "workspace" }, h.ctx);
	assert.match(pullConflict.error ?? "", /has local changes/);
	assert.equal(fs.readFileSync(localWorkspace, "utf8"), localBeforeConflictActions);

	fs.appendFileSync(path.join(project, ".pi", "tasks.jsonc"), "local change\n");
	fs.writeFileSync(path.join(seed, "projects", "project-alpha", "tasks.jsonc"), '{"tasks":["remote-v3"]}\n');
	git(seed, ["add", "projects/project-alpha/tasks.jsonc"]);
	git(seed, ["commit", "-m", "Update tasks again"]);
	git(seed, ["push", "origin", "main"]);

	const tasksConflict = await act(project, { action: "pull-project", scope: "tasks" }, h.ctx);
	assert.match(tasksConflict.error ?? "", /has local changes/);
	assert.match(fs.readFileSync(path.join(project, ".pi", "tasks.jsonc"), "utf8"), /local change/);
});

test("syncs task attachments as a portable project bundle and tracks attachment changes", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	const attachments = path.join(project, ".pi", "task-attachments");
	fs.mkdirSync(attachments, { recursive: true });
	const { remote, seed } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	h.setInput(async () => "task-assets");
	await act(project, { action: "project-key" }, h.ctx);
	const attachmentName = "100-1-shot.png";
	const attachment = path.join(attachments, attachmentName);
	fs.writeFileSync(attachment, Buffer.from([1, 2, 3, 4]));
	const marker = `[Pix attachment: ${pathToFileURL(attachment).href}]`;
	fs.writeFileSync(
		path.join(project, ".pi", "tasks.jsonc"),
		`// portable task bundle\n${JSON.stringify({ version: 1, tasks: [{ id: "task-1", description: marker }] }, null, 2)}\n`,
	);

	await act(project, { action: "push-project", scope: "tasks" }, h.ctx);
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	const remoteTasks = fs.readFileSync(path.join(seed, "projects", "task-assets", "tasks.jsonc"), "utf8");
	assert.match(remoteTasks, /\[Pix attachment: pix-task-attachment:100-1-shot\.png\]/);
	assert.equal(remoteTasks.includes(project), false);
	assert.deepEqual(
		fs.readFileSync(path.join(seed, "projects", "task-assets", "task-attachments", attachmentName)),
		Buffer.from([1, 2, 3, 4]),
	);

	fs.rmSync(path.join(project, ".pi", "tasks.jsonc"));
	fs.rmSync(attachments, { recursive: true, force: true });
	await act(project, { action: "pull-project", scope: "tasks" }, h.ctx);
	const pulledAttachment = path.join(project, ".pi", "task-attachments", attachmentName);
	const pulledTasks = fs.readFileSync(path.join(project, ".pi", "tasks.jsonc"), "utf8");
	assert.deepEqual(fs.readFileSync(pulledAttachment), Buffer.from([1, 2, 3, 4]));
	assert.match(pulledTasks, new RegExp(`\\[Pix attachment: ${pathToFileURL(pulledAttachment).href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
	assert.equal(pulledTasks.includes("pix-task-attachment:"), false);

	fs.writeFileSync(pulledAttachment, Buffer.from([9, 8, 7]));
	const changed = await act(project, { action: "refresh" }, h.ctx);
	assert.equal(item(changed, "project:tasks").status, "local-changes");

	fs.writeFileSync(
		path.join(project, ".pi", "tasks.jsonc"),
		`${JSON.stringify({ version: 1, tasks: [{ id: "task-1", description: "No attachment" }] }, null, 2)}\n`,
	);
	await act(project, { action: "push-project", scope: "tasks" }, h.ctx);
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.equal(fs.existsSync(path.join(seed, "projects", "task-assets", "task-attachments")), false);
});

test("treats an empty plans directory as removal of registry plans", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(path.join(project, ".pi", "plans"), { recursive: true });
	fs.writeFileSync(path.join(project, ".pi", "tasks.jsonc"), '{"tasks":["only"]}\n');
	const { remote, seed } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	h.setInput(async () => "empty-plans");
	await act(project, { action: "project-key" }, h.ctx);
	await act(project, { action: "push-project", scope: "project" }, h.ctx);
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.equal(fs.existsSync(path.join(seed, "projects", "empty-plans", "tasks.jsonc")), true);
	assert.equal(fs.existsSync(path.join(seed, "projects", "empty-plans", "plans")), false);

	h.notices.length = 0;
	await act(project, { action: "push-project", scope: "plans" }, h.ctx);
	assert.notEqual(h.notices.at(-1)?.type, "error");
	assert.match(h.notices.at(-1)?.message ?? "", /already has no plans\//);

	const localPlan = path.join(project, ".pi", "plans", "roadmap.md");
	fs.writeFileSync(localPlan, "roadmap v1\n");
	await act(project, { action: "push-project", scope: "plans" }, h.ctx);
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	const remotePlan = fs.readFileSync(path.join(seed, "projects", "empty-plans", "plans", "roadmap.md"), "utf8");
	assert.equal(remotePlan.replace(/\r\n/g, "\n"), "roadmap v1\n");

	fs.rmSync(localPlan);
	h.notices.length = 0;
	await act(project, { action: "push-project", scope: "plans" }, h.ctx);
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.equal(fs.existsSync(path.join(seed, "projects", "empty-plans", "plans")), false);
	assert.notEqual(h.notices.at(-1)?.type, "error");

	const provenance = JSON.parse(fs.readFileSync(path.join(project, ".pi", "registry.json"), "utf8"));
	assert.equal(provenance.projectResources.plans, undefined);
	const snapshot = await act(project, { action: "refresh" }, h.ctx);
	assert.equal(snapshot.items.some((entry) => entry.id === "project:plans"), false);
});

test("removes a single remote resource, keeps the project copy, and reports removed-remote status", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx);
	const projectSkill = path.join(project, ".pi", "skills", "demo", "SKILL.md");
	assert.equal(fs.existsSync(projectSkill), true);

	await act(project, { action: "remove", type: "skill", name: "demo" }, h.ctx);
	git(seed, ["pull", "--ff-only", "origin", "main"]);
	assert.equal(fs.existsSync(path.join(seed, "skills", "demo")), false);
	assert.equal(fs.existsSync(projectSkill), true);
	assert.match(h.notices.at(-1)?.message ?? "", /Project copies were kept/);

	const snapshot = await act(project, { action: "refresh" }, h.ctx);
	assert.equal(item(snapshot, "skill:demo").status, "removed-remote");
});

test("uninstalls a local resource, keeps the registry copy, and clears provenance", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx);

	await act(project, { action: "uninstall", type: "skill", name: "demo" }, h.ctx);
	assert.equal(fs.existsSync(path.join(project, ".pi", "skills", "demo")), false);
	assert.equal(fs.existsSync(path.join(seed, "skills", "demo", "SKILL.md")), true);
	assert.match(h.notices.at(-1)?.message ?? "", /Registry copy was kept/);

	const provenance = JSON.parse(fs.readFileSync(path.join(project, ".pi", "registry.json"), "utf8"));
	assert.equal(provenance.resources["skill:demo"], undefined);

	const snapshot = await act(project, { action: "refresh" }, h.ctx);
	assert.equal(item(snapshot, "skill:demo").status, "not-installed");
});

test("bootstraps the configured branch when the private registry repository is empty", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	const remote = path.join(root, "empty-registry.git");
	fs.mkdirSync(path.join(project, ".pi", "skills", "first"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".pi", "skills", "first", "SKILL.md"),
		"---\ndescription: First resource\n---\n\nBootstrap.\n",
	);
	git(root, ["init", "--bare", remote]);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	const snapshot = await act(project, { action: "push", type: "skill", name: "first" }, h.ctx);
	assert.equal(snapshot.error, undefined);
	assert.match(git(root, ["--git-dir", remote, "show", "main:skills/first/SKILL.md"]), /Bootstrap/);
	assert.match(h.notices.at(-1)?.message ?? "", /Pushed skill "first"/);
});

test("status marks simultaneous local and remote edits as diverged and update refuses to overwrite", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx);
	fs.appendFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "local change\n");
	fs.appendFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "remote change\n");
	git(seed, ["add", "skills/demo/SKILL.md"]);
	git(seed, ["commit", "-m", "Remote change"]);
	git(seed, ["push", "origin", "main"]);

	const snapshot = await act(project, { action: "refresh" }, h.ctx);
	assert.equal(item(snapshot, "skill:demo").status, "diverged");
	const update = await act(project, { action: "update", type: "skill", name: "demo" }, h.ctx);
	assert.match(update.error ?? "", /has local changes/);
	assert.match(fs.readFileSync(path.join(project, ".pi", "skills", "demo", "SKILL.md"), "utf8"), /local change/);
});

test("diffs changed skill trees and agent companions read-only against the fetched registry copy", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote, seed } = createRegistry(root);
	fs.mkdirSync(path.join(seed, "skills", "demo", "assets"), { recursive: true });
	fs.writeFileSync(path.join(seed, "skills", "demo", "assets", "shared.txt"), "shared v1\n");
	fs.mkdirSync(path.join(seed, "agents", "reviewer", "guides"), { recursive: true });
	fs.writeFileSync(path.join(seed, "agents", "reviewer", "guides", "review.md"), "first guide\n");
	fs.writeFileSync(path.join(seed, "agents", "reviewer", "stable.txt"), "stable\n");
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "Add resource assets"]);
	git(seed, ["push", "origin", "main"]);
	const h = harness(project);
	const svc = service();
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx, svc);
	await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx, svc);
	await act(project, { action: "install", type: "agent", name: "reviewer" }, h.ctx, svc);

	const filesByPath = async (type: "skill" | "agent", name: string) => {
		const payload = await svc.diff({ cwd: project, type, name });
		assert.equal(payload.version, 1);
		assert.equal(payload.type, type);
		assert.equal(payload.name, name);
		return new Map(payload.files.map((file) => [file.path, file]));
	};

	assert.deepEqual([...await filesByPath("skill", "demo")].length, 0);

	const localSkill = path.join(project, ".pi", "skills", "demo");
	fs.writeFileSync(path.join(localSkill, "SKILL.md"), "---\ndescription: Demo skill\n---\n\nlocal skill v3\n");
	fs.writeFileSync(path.join(localSkill, "extra.md"), "extra local\n");
	fs.rmSync(path.join(localSkill, "assets", "shared.txt"));
	fs.writeFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "---\ndescription: Demo skill\n---\n\nremote v2\n");
	git(seed, ["add", "skills/demo/SKILL.md"]);
	git(seed, ["commit", "-m", "Remote skill v2"]);
	git(seed, ["push", "origin", "main"]);

	const skillFiles = await filesByPath("skill", "demo");
	assert.deepEqual([...skillFiles.keys()].sort(), [
		"skills/demo/SKILL.md",
		"skills/demo/assets/shared.txt",
		"skills/demo/extra.md",
	]);
	assert.match(String(skillFiles.get("skills/demo/SKILL.md")?.oldText), /remote v2/);
	assert.match(String(skillFiles.get("skills/demo/SKILL.md")?.newText), /local skill v3/);
	assert.deepEqual(skillFiles.get("skills/demo/assets/shared.txt"), {
		path: "skills/demo/assets/shared.txt",
		oldText: "shared v1\n",
		newText: null,
	});
	assert.deepEqual(skillFiles.get("skills/demo/extra.md"), {
		path: "skills/demo/extra.md",
		oldText: null,
		newText: "extra local\n",
	});

	fs.writeFileSync(
		path.join(project, ".pi", "agents", "reviewer.md"),
		"---\ndescription: Review code\nmodels: [test/model]\n---\n\nLocal review body.\n",
	);
	fs.rmSync(path.join(project, ".pi", "agents", "reviewer", "guides", "review.md"));
	fs.writeFileSync(path.join(project, ".pi", "agents", "reviewer", "notes.md"), "local note\n");

	const agentFiles = await filesByPath("agent", "reviewer");
	assert.deepEqual([...agentFiles.keys()].sort(), [
		"agents/reviewer.md",
		"agents/reviewer/guides/review.md",
		"agents/reviewer/notes.md",
	]);
	assert.match(String(agentFiles.get("agents/reviewer.md")?.oldText), /Review carefully/);
	assert.match(String(agentFiles.get("agents/reviewer.md")?.newText), /Local review body/);
	assert.deepEqual(agentFiles.get("agents/reviewer/guides/review.md"), {
		path: "agents/reviewer/guides/review.md",
		oldText: "first guide\n",
		newText: null,
	});
	assert.deepEqual(agentFiles.get("agents/reviewer/notes.md"), {
		path: "agents/reviewer/notes.md",
		oldText: null,
		newText: "local note\n",
	});

	// The comparison is read-only: neither the project copies nor the registry
	// remote changed because of the diff.
	assert.match(fs.readFileSync(path.join(localSkill, "SKILL.md"), "utf8"), /local skill v3/);
	assert.match(fs.readFileSync(path.join(seed, "skills", "demo", "SKILL.md"), "utf8"), /remote v2/);
	assert.equal(fs.existsSync(path.join(seed, "agents", "reviewer", "guides", "review.md")), true);
});

test("registry diff validates targets, requires both copies, and rejects traversal", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	const svc = service();

	await assert.rejects(svc.diff({ cwd: project, type: "skill", name: "../etc" as never }), /Invalid resource name/);
	await assert.rejects(svc.diff({ cwd: project, type: "skill", name: "missing" }), /skill "missing" does not exist in the registry\./);
	await assert.rejects(svc.diff({ cwd: project, type: "skill", name: "demo" }), /Project skill "demo" does not exist\./);
	await assert.rejects(svc.diff({ cwd: project, type: "agent", name: "demo" }), /agent "demo" does not exist in the registry\./);
});

test("registry diff reports binary and oversized files as notices instead of skipping them", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx);
	const svc = service();
	const localSkill = path.join(project, ".pi", "skills", "demo");
	fs.writeFileSync(path.join(localSkill, "image.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
	fs.writeFileSync(path.join(localSkill, "big.txt"), "x".repeat(1_000_001));

	const first = await svc.diff({ cwd: project, type: "skill", name: "demo" });
	const firstByPath = new Map(first.files.map((file) => [file.path, file]));
	assert.deepEqual(firstByPath.get("skills/demo/image.bin"), {
		path: "skills/demo/image.bin",
		oldText: null,
		newText: null,
		notice: "Project copy is binary",
	});
	assert.equal(firstByPath.get("skills/demo/big.txt")?.notice?.includes("per-file diff limit"), true);

	await act(project, { action: "push", type: "skill", name: "demo" }, h.ctx);
	fs.writeFileSync(path.join(localSkill, "invalid.txt"), Buffer.from([0xff, 0xfe]));
	fs.writeFileSync(path.join(localSkill, "image.bin"), "now text\n");
	fs.writeFileSync(path.join(localSkill, "long.txt"), "line\n".repeat(2_100));
	const next = await svc.diff({ cwd: project, type: "skill", name: "demo" });
	assert.ok(next.files.some((file) =>
		file.path === "skills/demo/image.bin" && file.oldText === null && file.newText === null && file.notice === "Registry copy is binary",
	));
	assert.ok(next.files.some((file) =>
		file.path === "skills/demo/invalid.txt" && file.notice === "Project copy is binary",
	));
	assert.ok(next.files.some((file) =>
		file.path === "skills/demo/long.txt" && file.notice?.includes("line display limit"),
	));
	assert.equal(next.files.some((file) => file.path === "skills/demo/big.txt"), false);
});

test("registry diff rejects symbolic links instead of following them", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
	const root = tempRoot();
	isolate(root);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const { remote } = createRegistry(root);
	const h = harness(project);
	h.setInput(async (title) => (title === "Registry Git remote" ? remote : "main"));
	await act(project, { action: "configure" }, h.ctx);
	await act(project, { action: "install", type: "skill", name: "demo" }, h.ctx);
	const secret = path.join(root, "secret.txt");
	fs.writeFileSync(secret, "outside the resource\n");
	fs.symlinkSync(secret, path.join(project, ".pi", "skills", "demo", "leaked.md"));

	await assert.rejects(
		service().diff({ cwd: project, type: "skill", name: "demo" }),
		/Registry diff cannot traverse symbolic links: skills\/demo\/leaked\.md/,
	);
	assert.equal(fs.readFileSync(secret, "utf8"), "outside the resource\n");
});
