import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildPiToolsSuite, preserveSourceUrls } from "../scripts/build-pi-tools-suite.mjs";
import { suiteRuntimeCurrent } from "../external/pi-tools-suite/runtime-loader.mjs";
import { pruneSuiteRuntime } from "../scripts/release/prune.mjs";

test("bundled suite preserves SDK identity, assets, module isolation and fresh reloads", { timeout: 60_000 }, async () => {
	await mkdir(".pi/artifacts", { recursive: true });
	const root = resolve(await mkdtemp(".pi/artifacts/suite-runtime-"));
	const rootUrl = pathToFileURL(`${root}/`);
	try {
		await mkdir(join(root, "src"));
		await mkdir(join(root, "agent"));
		await writeFile(join(root, "package.json"), '{"type":"module"}');
		for (const name of ["index.ts", "runtime-loader.mjs"]) await copyFile(`external/pi-tools-suite/${name}`, join(root, name));
		await copyFile("external/pi-tools-suite/src/module-loader.ts", join(root, "src/module-loader.ts"));
		await writeFile(join(root, "src/module-catalog.ts"), 'export const PI_TOOLS_SUITE_MODULE_CATALOG = ["alpha", "broken", "beta"].map(name => ({name}));');
		await writeFile(join(root, "src/index.ts"), `
import { loadSuiteModules } from './module-loader.ts';
export default async (pi: any) => loadSuiteModules(pi, ['alpha', 'broken', 'beta'].map(name => ({name, load: () => import(\`./\${name}/index.ts\`)})));
`);
		const sharedSource = (version: string) => `
export { SettingsManager } from '@earendil-works/pi-coding-agent';
export const shared = {};
export const version = ${JSON.stringify(version)};
export const asset = new URL('./fixture.md', import.meta.url).href;
`;
		await writeFile(join(root, "src/shared.ts"), sharedSource("v1"));
		await writeFile(join(root, "src/fixture.md"), "asset");
		for (const name of ["alpha", "broken", "beta"]) {
			await mkdir(join(root, "src", name));
			await writeFile(join(root, "src", name, "index.ts"), `
import * as snapshot from '../shared.ts';
export default (pi: any) => {
 pi.registerCommand('${name}', { handler: async (_args: string, ctx: any) => ctx.ui.notify(snapshot) });
 ${name === "broken" ? "throw new Error('isolated fixture failure');" : ""}
};`);
		}
		// Native .mjs loading would select this wrong package instead of the host alias.
		const wrongSdk = join(root, "node_modules/@earendil-works/pi-coding-agent");
		await mkdir(wrongSdk, { recursive: true });
		await writeFile(join(wrongSdk, "package.json"), '{"type":"module","exports":"./index.js"}');
		await writeFile(join(wrongSdk, "index.js"), "export class SettingsManager {}");
		assert.equal(await suiteRuntimeCurrent(rootUrl), undefined);
		const manifest = await buildPiToolsSuite(root);
		assert.equal(await suiteRuntimeCurrent(rootUrl), manifest.entry);
		const outputPath = join(root, manifest.entry);
		const published = await stat(outputPath);
		await buildPiToolsSuite(root);
		assert.equal((await stat(outputPath)).mtimeMs, published.mtimeMs, "rebuild must not truncate live content-addressed outputs");
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"),
			settingsManager: SettingsManager.create(root, join(root, "agent"), { projectTrusted: true }),
			additionalExtensionPaths: [join(root, "index.ts")],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		async function snapshot() {
			await loader.reload();
			const result = loader.getExtensions();
			assert.deepEqual(result.errors, []);
			const extension = result.extensions.find((extension) => extension.commands.has("alpha"))!;
			assert.ok(extension);
			assert.equal(extension.commands.has("broken"), false);
			const values: any[] = [];
			for (const name of ["alpha", "beta"]) await extension.commands.get(name)!.handler("", {
				ui: { notify: (value: unknown) => values.push(value) },
			} as any);
			assert.equal(values[0].shared, values[1].shared);
			assert.equal(values[0].SettingsManager, SettingsManager);
			assert.equal(await readFile(new URL(values[0].asset), "utf8"), "asset");
			return values[0];
		}
		const first = await snapshot();
		const reloaded = await snapshot();
		assert.notEqual(first.shared, reloaded.shared, "reload must not reuse native-cached bundle state");
		await writeFile(join(root, "src/shared.ts"), sharedSource("v2"));
		assert.equal(await suiteRuntimeCurrent(rootUrl), undefined);
		assert.equal((await snapshot()).version, "v2", "stale builds must use edited source");
		const rebuilt = await buildPiToolsSuite(root);
		assert.equal(await suiteRuntimeCurrent(rootUrl), rebuilt.entry);
		assert.equal((await snapshot()).version, "v2");
		assert.equal(first.version, "v1", "old handlers retain their own generation");
		await rm(join(root, rebuilt.outputs.find((path: string) => path !== rebuilt.entry)!));
		assert.equal(await suiteRuntimeCurrent(rootUrl), undefined, "missing chunks must fall back before loading");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("bundler fails closed on unknown import.meta semantics", () => {
	assert.throws(() => preserveSourceUrls('import.meta.resolve("tsx")', "/suite/src/file.ts", "/suite"), /Unsupported import.meta/);
});

test("release pack allowlist includes the current runtime and every fingerprinted source", { timeout: 60_000 }, async () => {
	const manifest = await buildPiToolsSuite();
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const { stdout } = await promisify(execFile)(npm, ["pack", "--dry-run", "--ignore-scripts", "--json"],
		{ maxBuffer: 8 * 1024 * 1024, shell: process.platform === "win32" });
	const [pack] = JSON.parse(stdout);
	const paths = new Set(pack.files.map((file: { path: string }) => file.path));
	for (const path of ["build/runtime/manifest.json", ...manifest.outputs, ...Object.keys(manifest.inputs)]) {
		assert.ok(paths.has(`external/pi-tools-suite/${path}`), `missing from package: ${path}`);
	}
	const prepare = await readFile("scripts/release/prepare.mjs", "utf8");
	const buildAt = prepare.indexOf('npm(["run", "build:tools-suite"])');
	assert.ok(buildAt >= 0 && buildAt < prepare.indexOf('npm(["pack", "--ignore-scripts"'),
		"release preparation builds the runtime before packing with lifecycle scripts disabled");
	assert.ok(prepare.indexOf("await pruneSuiteRuntime(app)") > prepare.indexOf('run("tar"')
		&& prepare.indexOf("await pruneSuiteRuntime(app)") < prepare.indexOf('npm(["ci"'), "only the staged copy is pruned");
});

test("release staging retains only current runtime outputs and rejects unsafe manifests", async () => {
	await mkdir(".pi/artifacts", { recursive: true });
	const root = resolve(await mkdtemp(".pi/artifacts/suite-release-"));
	const runtime = join(root, "external/pi-tools-suite/build/runtime");
	try {
		await mkdir(runtime, { recursive: true });
		for (const name of ["current.mts", "old.mts", "interrupted.tmp"]) await writeFile(join(runtime, name), name);
		const manifest = { version: 1, entry: "build/runtime/current.mts", outputs: ["build/runtime/current.mts"] };
		await writeFile(join(runtime, "manifest.json"), JSON.stringify(manifest));
		await pruneSuiteRuntime(root);
		assert.equal(await readFile(join(runtime, "current.mts"), "utf8"), "current.mts");
		assert.equal(JSON.parse(await readFile(join(runtime, "manifest.json"), "utf8")).entry, manifest.entry);
		for (const name of ["old.mts", "interrupted.tmp"]) await assert.rejects(readFile(join(runtime, name)), { code: "ENOENT" });
		await writeFile(join(runtime, "manifest.json"), JSON.stringify({ ...manifest, outputs: [manifest.entry, "build/runtime/../outside.mts"] }));
		await assert.rejects(pruneSuiteRuntime(root), /Invalid suite runtime manifest/);
		assert.equal(await readFile(join(runtime, "current.mts"), "utf8"), "current.mts", "invalid manifests must not delete files");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
