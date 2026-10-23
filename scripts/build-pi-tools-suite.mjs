import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const defaultSource = fileURLToPath(new URL("../external/pi-tools-suite/", import.meta.url));
const portable = (path) => path.split(sep).join("/");
const hash = (content) => createHash("sha256").update(content).digest("hex");

async function publishFile(path, content, immutable = false) {
	if (immutable) {
		try {
			if (hash(await readFile(path)) !== hash(content)) throw new Error(`Runtime output collision: ${path}`);
			return;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Bundle-local import.meta.url must still locate the original workers/assets. */
export function preserveSourceUrls(source, filename, sourceRoot) {
	const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
	const replacements = [];
	function visit(node) {
		if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression)) {
			if (node.name.text !== "url") throw new Error(`Unsupported import.meta use in ${filename}`);
			const fromRuntime = `../../${portable(relative(sourceRoot, filename))}`;
			replacements.push({ start: node.getStart(tree), end: node.end,
				text: `new URL(${JSON.stringify(fromRuntime)}, import.meta.url).href` });
			return;
		}
		if (ts.isMetaProperty(node)) throw new Error(`Unsupported import.meta use in ${filename}`);
		ts.forEachChild(node, visit);
	}
	visit(tree);
	for (const edit of replacements.reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
	return source;
}

export async function buildPiToolsSuite(sourceRoot = defaultSource) {
	sourceRoot = resolve(sourceRoot);
	const catalogSource = await readFile(join(sourceRoot, "src/module-catalog.ts"), "utf8");
	const snapshots = new Map([["src/module-catalog.ts", hash(catalogSource)]]);
	for (const name of ["index.ts", "runtime-loader.mjs"]) snapshots.set(name, hash(await readFile(join(sourceRoot, name))));
	const catalogJs = ts.transpileModule(catalogSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
	const { PI_TOOLS_SUITE_MODULE_CATALOG: catalog } = await import(`data:text/javascript;base64,${Buffer.from(catalogJs).toString("base64")}`);
	const entries = { suite: join(sourceRoot, "src/index.ts") };
	for (const { name } of catalog) entries[`module-${name}`] = join(sourceRoot, "src", name, "index.ts");
	const runtimeDir = join(sourceRoot, "build/runtime");
	const result = await build({
		absWorkingDir: sourceRoot, entryPoints: entries, outdir: runtimeDir,
		bundle: true, splitting: true, format: "esm", platform: "node", target: "node22",
		packages: "external", outExtension: { ".js": ".mts" },
		entryNames: "[name]-[hash]", chunkNames: "shared-[hash]", metafile: true, write: false,
		plugins: [{ name: "source-relative-assets", setup(builder) {
			builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async ({ path }) => {
				const source = await readFile(path, "utf8");
				const name = portable(relative(sourceRoot, path));
				if (name.startsWith("../")) throw new Error(`Runtime source outside suite: ${name}`);
				const fingerprint = hash(source);
				if (snapshots.has(name) && snapshots.get(name) !== fingerprint) throw new Error(`Source changed during build: ${name}`);
				snapshots.set(name, fingerprint);
				return { contents: preserveSourceUrls(source, path, sourceRoot),
					loader: path.endsWith("ts") ? "ts" : "js", resolveDir: dirname(path) };
			});
		} }],
	});
	const inputs = {};
	for (const name of new Set([...Object.keys(result.metafile.inputs), ...snapshots.keys()])) {
		const key = portable(name);
		const fingerprint = hash(await readFile(resolve(sourceRoot, name)));
		if (snapshots.get(key) !== fingerprint) throw new Error(`Source changed during build: ${key}`);
		inputs[key] = fingerprint;
	}
	const entry = Object.entries(result.metafile.outputs).find(([, output]) => output.entryPoint === "src/index.ts")?.[0];
	if (!entry) throw new Error("Suite runtime entry was not emitted");
	await mkdir(runtimeDir, { recursive: true });
	// Content-addressed files stay valid for already-running lazy imports. Never
	// remove another live generation while publishing a rebuilt developer bundle.
	for (const file of result.outputFiles) await publishFile(file.path, file.contents, true);
	const manifest = { version: 1, entry: portable(entry), inputs,
		outputs: result.outputFiles.map((file) => portable(relative(sourceRoot, file.path))) };
	await publishFile(join(runtimeDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
	return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await buildPiToolsSuite(process.argv[2]);
}
