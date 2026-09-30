import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RegistryContext } from "../src/registry/context.js";
import { parseAgentMarkdown } from "../src/registry/agent-markdown.js";
import { editResourceTags, normalizeTags, readResourceTags, writeResourceTags } from "../src/registry/metadata.js";

const roots: string[] = [];

test("optional tags accept YAML arrays, preserve unrelated frontmatter/body and clear explicitly", () => {
	const source = "---\r\nname: example\r\ndescription: >\r\n  A skill\r\n# retained\r\ntags:\r\n  - review\r\n  - 'security'\r\nmodels: [test/model]\r\n---\r\nBody with tags: unchanged\r\n";
	assert.deepEqual(readResourceTags(source), ["review", "security"]);
	const updated = writeResourceTags(source, [" docs ", "docs", "a: b"]);
	assert.equal(updated, source.replace("tags:\r\n  - review\r\n  - 'security'", 'tags: ["docs","a: b"]'));
	assert.deepEqual(readResourceTags(updated), ["docs", "a: b"]);
	assert.deepEqual(readResourceTags(writeResourceTags(updated, [])), []);
	assert.deepEqual(readResourceTags("---\ntags: invalid\n---\n"), []);
	assert.deepEqual(readResourceTags("No frontmatter"), []);
	assert.throws(() => writeResourceTags("---\ntags: []\ntags: []\n---\n", []), /Duplicate/);
	assert.throws(() => normalizeTags(["bad\nvalue"]));
	assert.throws(() => normalizeTags(Array.from({ length: 33 }, (_, index) => String(index))));
});

test("agent tags are optional metadata, not a prompt or model setting", () => {
	const agent = parseAgentMarkdown('---\ndescription: Reviewer\nmodels: [test/model]\ntags: ["quality"]\n---\nReview.', "reviewer.md");
	assert.deepEqual(agent?.frontmatter.tags, ["quality"]);
	assert.equal(agent?.body, "Review.");
	assert.throws(() => parseAgentMarkdown("---\ntags: [1]\n---\n", "reviewer.md"), /array of strings/);
});

test("editing is prefilled, cancel-safe and refuses a stale or symlinked completion", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "registry-tags-"));
	roots.push(cwd);
	const dir = join(cwd, ".pi", "skills", "demo");
	await mkdir(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	const source = '---\nname: demo\ndescription: Demo\ntags: ["existing"]\n---\nBody\n';
	await writeFile(file, source);
	let prefill: string | undefined;
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			confirm: async () => true,
			input: async () => undefined,
			editor: async (_title: string, initial: string) => { prefill = initial; return undefined; },
			notify: () => {},
		},
	} as unknown as RegistryContext;
	await assert.rejects(editResourceTags(ctx, file, "Tags"), /cancelled/);
	assert.equal(prefill, "existing");
	assert.equal(await readFile(file, "utf8"), source);
	ctx.ui.editor = async () => { await writeFile(file, source + "Other edit\n"); return "new"; };
	await assert.rejects(editResourceTags(ctx, file, "Tags"), /changed while editing/);
	assert.equal(await readFile(file, "utf8"), source + "Other edit\n");
	ctx.ui.editor = async () => "short";
	assert.equal(await editResourceTags(ctx, file, "Tags"), true);
	assert.equal(await readFile(file, "utf8"), writeResourceTags(source + "Other edit\n", ["short"]));
	const outside = join(cwd, "outside.md");
	await writeFile(outside, source);
	ctx.ui.editor = async () => { await rm(file); await symlink(outside, file); return "unsafe"; };
	await assert.rejects(editResourceTags(ctx, file, "Tags"), /symbolic link/);
	assert.equal(await readFile(outside, "utf8"), source);
});

after(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
