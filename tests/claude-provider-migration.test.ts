import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateProviderSettings, migrateSettingsFile } from "../scripts/migrate-claude-provider.mjs";

test("migration disables only the old package resources and explicit old entrypoints", () => {
	const input = JSON.stringify({
		packages: ["npm:pi-claude-code-provider@0.5.0", { source: "npm:pi-claude-code-provider", skills: [], autoload: false }, "npm:other"],
		extensions: ["/a/pi-claude-code-provider/extensions/index.ts", "/suite/src/claude-code-provider/index.ts", "./other.ts"],
		defaultProvider: "pi-claude-code-provider", defaultModel: "sonnet", unrelated: { keep: true },
	});
	const result = migrateProviderSettings(input);
	const settings = JSON.parse(result);
	assert.deepEqual(settings.packages, [
		{ source: "npm:pi-claude-code-provider@0.5.0", extensions: [] },
		{ source: "npm:pi-claude-code-provider", skills: [], autoload: false, extensions: [] }, "npm:other",
	]);
	assert.deepEqual(settings.extensions, ["/suite/src/claude-code-provider/index.ts", "./other.ts"]);
	assert.equal(settings.defaultProvider, "pi-claude-code-provider");
	assert.equal(settings.defaultModel, "sonnet");
	assert.deepEqual(settings.unrelated, { keep: true });
	assert.equal(migrateProviderSettings(result), result);
});

test("migration preserves comments and rejects invalid documents without leaking content", () => {
	const input = '{\n// keep me\n"packages": ["npm:pi-claude-code-provider"],\n"other": 42,\n}';
	assert.match(migrateProviderSettings(input), /\/\/ keep me/);
	assert.throws(() => migrateProviderSettings("{broken"), /^Error: Invalid settings document/);
	assert.equal(migrateProviderSettings('{"packages":["npm:pi-claude-code-provider-other"]}'), '{"packages":["npm:pi-claude-code-provider-other"]}');
});

test("file migration is checkable, idempotent, locked, and never follows credential-adjacent symlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "pix-provider-migration-"));
	const file = join(root, "settings.json");
	const input = '{"packages":["npm:pi-claude-code-provider"]}';
	try {
		await writeFile(file, input, { mode: 0o600 });
		assert.equal(await migrateSettingsFile(file, true), true);
		assert.equal(await readFile(file, "utf8"), input);
		await writeFile(`${file}.claude-provider-migration.lock`, "synthetic owner");
		await assert.rejects(migrateSettingsFile(file), /EEXIST/);
		await rm(`${file}.claude-provider-migration.lock`);
		assert.equal(await migrateSettingsFile(file), true);
		assert.equal(await migrateSettingsFile(file, true), false);
		const link = join(root, "link.json");
		await symlink(file, link);
		await assert.rejects(migrateSettingsFile(link), /regular file/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("default-target sync rejects a current project's legacy provider before publishing", async () => {
	const root = await mkdtemp(join(tmpdir(), "pix-provider-sync-"));
	try {
		await mkdir(join(root, ".pi"));
		const file = join(root, ".pi/settings.json");
		const input = '{"packages":["npm:pi-claude-code-provider"]}';
		await writeFile(file, input);
		const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/sync-pi-tools-suite.mjs", import.meta.url)), "--check"], {
			cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: "utf8", timeout: 10_000,
		});
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /project's legacy Claude provider/);
		assert.equal(await readFile(file, "utf8"), input);
	} finally { await rm(root, { recursive: true, force: true }); }
});
