import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentMarkdown } from "../src/async-subagents/core/agents-dir.js";
import { editResourceTags, normalizeTags, readResourceTags, writeResourceTags } from "../src/resource-registry/metadata.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("optional tags accept YAML arrays, preserve unrelated frontmatter/body and clear explicitly", () => {
	const source = "---\r\nname: example\r\ndescription: >\r\n  A skill\r\n# retained\r\ntags:\r\n  - review\r\n  - 'security'\r\nmodels: [test/model]\r\n---\r\nBody with tags: unchanged\r\n";
	expect(readResourceTags(source)).toEqual(["review", "security"]);
	const updated = writeResourceTags(source, [" docs ", "docs", "a: b"]);
	expect(updated).toBe(source.replace("tags:\r\n  - review\r\n  - 'security'", 'tags: ["docs","a: b"]'));
	expect(readResourceTags(updated)).toEqual(["docs", "a: b"]);
	expect(readResourceTags(writeResourceTags(updated, []))).toEqual([]);
	expect(readResourceTags("---\ntags: invalid\n---\n")).toEqual([]);
	expect(readResourceTags("No frontmatter")).toEqual([]);
	expect(() => writeResourceTags("---\ntags: []\ntags: []\n---\n", [])).toThrow("Duplicate");
	expect(() => normalizeTags(["bad\nvalue"])).toThrow();
	expect(() => normalizeTags(Array.from({ length: 33 }, (_, index) => String(index)))).toThrow();
});

test("agent tags are optional metadata, not a prompt or model setting", () => {
	const agent = parseAgentMarkdown('---\ndescription: Reviewer\nmodels: [test/model]\ntags: ["quality"]\n---\nReview.', "reviewer.md");
	expect(agent?.frontmatter.tags).toEqual(["quality"]);
	expect(agent?.body).toBe("Review.");
	expect(() => parseAgentMarkdown("---\ntags: [1]\n---\n", "reviewer.md")).toThrow("array of strings");
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
	const ctx = { cwd, hasUI: true, ui: { editor: async (_title: string, initial: string) => { prefill = initial; return undefined; } } } as any;
	await expect(editResourceTags(ctx, file, "Tags")).rejects.toThrow("cancelled");
	expect(prefill).toBe("existing");
	expect(await readFile(file, "utf8")).toBe(source);
	ctx.ui.editor = async () => { await writeFile(file, source + "Other edit\n"); return "new"; };
	await expect(editResourceTags(ctx, file, "Tags")).rejects.toThrow("changed while editing");
	expect(await readFile(file, "utf8")).toBe(source + "Other edit\n");
	ctx.ui.editor = async () => "short";
	expect(await editResourceTags(ctx, file, "Tags")).toBe(true);
	expect(await readFile(file, "utf8")).toBe(writeResourceTags(source + "Other edit\n", ["short"]));
	const outside = join(cwd, "outside.md");
	await writeFile(outside, source);
	ctx.ui.editor = async () => { await rm(file); await symlink(outside, file); return "unsafe"; };
	await expect(editResourceTags(ctx, file, "Tags")).rejects.toThrow("symbolic link");
	expect(await readFile(outside, "utf8")).toBe(source);
});
