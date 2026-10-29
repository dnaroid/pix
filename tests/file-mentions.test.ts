import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMentionIndex } from "../src/file-mention-index.js";
import { fileMentionQuery, fileMentionToken, fileMentionTokens, insertFileMention } from "../src/file-mentions.js";
import { InputEditor } from "../src/input-editor.js";
import { AppFileMentionsController } from "../src/app/input/file-mentions-controller.js";

describe("file mention syntax", () => {
	it("finds a mention at the caret, not an email, slash command, selection or shell", () => {
		assert.deepEqual(fileMentionQuery("inspect @src/fuz then", 16), { start: 8, end: 16, query: "src/fuz" });
		for (const text of ["a@b", "/model @src", "!echo @src", "@src "]) assert.equal(fileMentionQuery(text, text.length), undefined);
		assert.equal(fileMentionQuery("@src", 2, 4), undefined);
		assert.deepEqual(fileMentionQuery("@", 1), { start: 0, end: 1, query: "" });
	});
	it("replaces only the query and roundtrips spaces, quotes and folders as plain path text", () => {
		const text = "read @sr then continue";
		const insertion = insertFileMention(text, fileMentionQuery(text, 8)!, 'src/a "b".ts');
		assert.equal(insertion.text, `read @${JSON.stringify('src/a "b".ts')}  then continue`);
		assert.equal(fileMentionTokens(insertion.text)[0]?.path, 'src/a "b".ts');
		assert.equal(fileMentionToken("src/"), "@src/");
		assert.equal(fileMentionQuery("@packages/@scope/", 17)?.query, "packages/@scope/");
		assert.equal(fileMentionToken("packages/@scope/file.ts"), '@"packages/@scope/file.ts"');
		assert.equal(fileMentionTokens('@"packages/@scope/file.ts" ')[0]?.path, "packages/@scope/file.ts");
	});
	it("styles wrapped mention tokens but sends the literal path without attaching contents", () => {
		const editor = new InputEditor();
		editor.setText('Inspect @"src/file name.ts" ');
		assert.equal(editor.promptText, editor.text);
		assert.equal(editor.expandedText, editor.text);
		assert.equal(editor.attachments.length, 0);
		assert.ok(editor.render(12, 10, "", "").visualLines.filter((line) => line.tagSpans.length).length >= 2);
	});
});

describe("off-thread file mention index", () => {
	it("keeps the input event loop usable while indexing a large project", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-mentions-large-"));
		const index = new FileMentionIndex();
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		try {
			for (let base = 0; base < 8_000; base += 100) {
				await Promise.all(Array.from({ length: 100 }, (_, offset) => writeFile(join(cwd, `fixture-${String(base + offset).padStart(5, "0")}.ts`), "")));
			}
			const editor = new InputEditor();
			let inputEvents = 0;
			heartbeat = setInterval(() => { editor.insert("x"); editor.render(80, 8, "", ""); inputEvents++; }, 1);
			const matches = await index.query(cwd, "fixture-07999.ts");
			assert.equal(matches[0]?.path, "fixture-07999.ts");
			assert.ok(inputEvents > 0, "main-thread input must progress during worker indexing");
			assert.equal(editor.text.length, inputEvents);
		} finally {
			if (heartbeat) clearInterval(heartbeat);
			index.dispose(); await rm(cwd, { recursive: true, force: true });
		}
	});
	it("ranks basename matches, includes folders and enforces nested gitignore and negations", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-mentions-"));
		const index = new FileMentionIndex();
		try {
			await mkdir(join(cwd, "src")); await mkdir(join(cwd, "ignored"));
			await writeFile(join(cwd, ".gitignore"), "ignored/\n*.log\n");
			await writeFile(join(cwd, "src", ".gitignore"), "private.ts\n!keep.log\n");
			for (const path of ["src/autocomplete.ts", "src/private.ts", "src/keep.log", "src/drop.log", "ignored/secret.ts", "a-long-autocomplete-other.ts"]) await writeFile(join(cwd, path), "secret contents are not indexed");
			const all = await index.query(cwd, "");
			assert.ok(all.some((entry) => entry.path === "src/" && entry.directory));
			assert.ok(all.some((entry) => entry.path === "src/keep.log"));
			assert.ok(!all.some((entry) => /private|drop|secret|ignored/u.test(entry.path)));
			const ranked = await index.query(cwd, "autocomplete.ts");
			assert.equal(ranked[0]?.path, "src/autocomplete.ts");
			assert.ok(ranked.every((entry) => Object.keys(entry).sort().join() === "directory,path"));
		} finally { index.dispose(); await rm(cwd, { recursive: true, force: true }); }
	});
	it("incrementally picks up additions, renames, deletion and ignore-rule edits", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-mentions-watch-"));
		const index = new FileMentionIndex();
		async function until(predicate: (paths: string[]) => boolean): Promise<void> {
			const timeout = AbortSignal.timeout(10_000);
			while (!predicate((await index.query(cwd, "", timeout)).map((entry) => entry.path))) {
				timeout.throwIfAborted();
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
		try {
			await index.query(cwd, "");
			await writeFile(join(cwd, "first.ts"), ""); await until((paths) => paths.includes("first.ts"));
			await rename(join(cwd, "first.ts"), join(cwd, "second.ts"));
			await until((paths) => paths.includes("second.ts") && !paths.includes("first.ts"));
			await writeFile(join(cwd, ".gitignore"), "second.ts\n"); await until((paths) => !paths.includes("second.ts"));
			await writeFile(join(cwd, ".gitignore"), ""); await until((paths) => paths.includes("second.ts"));
			await rm(join(cwd, "second.ts")); await until((paths) => !paths.includes("second.ts"));
		} finally { index.dispose(); await rm(cwd, { recursive: true, force: true }); }
	});
	it("cancels requests, rejects index errors, and retires work on project switch/dispose", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-mentions-life-"));
		const index = new FileMentionIndex();
		try {
			const abort = new AbortController();
			const request = index.query(cwd, "", abort.signal); abort.abort(); assert.deepEqual(await request, []);
			const old = index.query(cwd, "");
			await assert.rejects(index.query(join(cwd, "missing"), ""), /ENOENT/u);
			assert.deepEqual(await old, []);
			await mkdir(join(cwd, ".gitignore"));
			await assert.rejects(index.query(cwd, ""), /EISDIR/u);
			await rm(join(cwd, ".gitignore"), { recursive: true });
			await writeFile(join(cwd, "recovered.ts"), "");
			assert.equal((await index.query(cwd, "recovered.ts"))[0]?.path, "recovered.ts");
			const pending = index.query(cwd, ""); index.dispose(); assert.deepEqual(await pending, []);
		} finally { index.dispose(); await rm(cwd, { recursive: true, force: true }); }
	});
	it("TUI insertion retains attachment state, plain prompt text and undo", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-mentions-tui-"));
		const editor = new InputEditor();
		let changed: (() => void) | undefined;
		let renders = 0;
		const controller = new AppFileMentionsController(() => editor, () => cwd, () => "session", () => { renders++; changed?.(); });
		try {
			await writeFile(join(cwd, "file name.ts"), "");
			editor.attachImage("base64-image", "image/png");
			editor.insert(" check @file");
			const original = editor.text;
			const prefix = original.slice(0, original.indexOf("@file"));
			let resolveReady: () => void = () => {};
			const ready = new Promise<void>((resolve, reject) => {
				resolveReady = resolve;
				const signal = AbortSignal.timeout(10_000);
				signal.addEventListener("abort", () => reject(new Error("TUI file search did not produce a match")), { once: true });
			});
			changed = () => { if (controller.menu.selectedItem()?.value.value) resolveReady(); };
			assert.equal(controller.sync(true), true);
			assert.equal(renders, 0, "synchronous query startup must not render inside render");
			await ready;
			controller.accept();
			assert.equal(editor.text, `${prefix}@"file name.ts" `);
			assert.equal(editor.attachments.length, 1);
			assert.equal(editor.attachments[0]?.kind, "image");
			editor.undo(); assert.equal(editor.text, original);
			assert.equal(editor.attachments.length, 1);
			controller.dismiss(); assert.equal(controller.sync(true), false);
		} finally { controller.dispose(); await rm(cwd, { recursive: true, force: true }); }
	});
});
