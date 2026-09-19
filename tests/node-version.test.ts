import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const readText = (path: string): string => readFileSync(join(repoRoot, path), "utf8");
const readJson = (path: string) => JSON.parse(readText(path));
const rootPackage = readJson("package.json");
const supportedRange: string = rootPackage.engines.node;

// Exercise the shipped launcher, but never load the real app or touch user configuration.
function runLauncher(t: TestContext, version: string, range = supportedRange) {
	const root = mkdtempSync(join(tmpdir(), "pix-node-version-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	mkdirSync(join(root, "bin"));
	mkdirSync(join(root, "dist"));
	copyFileSync(join(repoRoot, "bin", "pix.mjs"), join(root, "bin", "pix.mjs"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", engines: { node: range } }));
	writeFileSync(join(root, "dist", "main.js"), 'console.log("PIX_TEST_APP_STARTED");\n');
	const launcherUrl = pathToFileURL(join(root, "bin", "pix.mjs")).href;
	const result = spawnSync(process.execPath, [
		"--input-type=module",
		"--eval",
		`Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
		await import(${JSON.stringify(launcherUrl)});`,
	], { cwd: root, encoding: "utf8", timeout: 15_000 });
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
	return result;
}

describe("Node version configuration", () => {
	it("has no project-level Node version-manager pins", () => {
		for (const path of [".node-version", ".nvmrc", ".tool-versions", "mise.toml", ".mise.toml"]) {
			assert.equal(existsSync(join(repoRoot, path)), false, path);
		}
	});

	it("shares the root engine range across packages, lockfiles, and documentation", () => {
		assert.match(supportedRange, /^>=\d+\.\d+\.\d+ <\d+$/u);
		for (const prefix of ["", "acp/", "desktop/"]) {
			assert.equal(readJson(`${prefix}package.json`).engines.node, supportedRange, prefix || "root");
			assert.equal(readJson(`${prefix}package-lock.json`).packages[""].engines.node, supportedRange, `${prefix}lockfile`);
		}
		assert.ok(readText("README.md").includes(`**Node.js \`${supportedRange}\`**`));
	});

	it("uses the selected PATH runtime without a mise configuration or script wrappers", () => {
		for (const prefix of ["", "acp/", "desktop/", "external/pi-tools-suite/"]) {
			for (const [name, script] of Object.entries(readJson(`${prefix}package.json`).scripts)) {
				assert.doesNotMatch(String(script), /\bmise\b|\bnode@\d/u, `${prefix}${name}`);
			}
		}
	});

	it("keeps CI and release jobs on the runner PATH runtime", () => {
		for (const name of ["check", "publish"]) {
			const workflow = readText(`.github/workflows/${name}.yml`);
			assert.doesNotMatch(workflow, /actions\/setup-node|node-version(?:-file)?:|matrix\.node|\bmise\b/u, name);
			assert.match(workflow, /node --version/u, name);
			assert.match(workflow, /npm --version/u, name);
		}
	});
});

describe("Pix launcher Node version guard", () => {
	for (const version of new Set(["22.19.0", "22.19.1", "22.20.0", "23.0.0", "24.0.0", "25.0.0", "26.0.0", "26.7.0", process.versions.node])) {
		it(`accepts supported Node ${version}`, (t) => {
			const result = runLauncher(t, version);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout.trim(), "PIX_TEST_APP_STARTED");
			assert.equal(result.stderr, "");
		});
	}

	for (const version of ["20.20.2", "22.18.99", "27.0.0", "28.0.0", "26.0.0-rc.1", "invalid"]) {
		it(`rejects unsupported Node ${version} before loading the app`, (t) => {
			const result = runLauncher(t, version);
			assert.equal(result.status, 1);
			assert.equal(result.stdout, "");
			assert.ok(result.stderr.includes(`Node ${supportedRange} is required; current Node is ${version}.`));
			assert.doesNotMatch(result.stderr, /\bmise\b/u);
		});
	}

	it("reads the installed package range instead of a hardcoded launcher version", (t) => {
		const result = runLauncher(t, "26.1.2", ">=26.1.2 <27");
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "PIX_TEST_APP_STARTED");
	});

	it("fails closed on an unrecognized engine range", (t) => {
		const result = runLauncher(t, process.versions.node, ">=22.19.0");
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
	});
});
