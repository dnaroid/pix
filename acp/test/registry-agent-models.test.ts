import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentModelOverrides, readAgentModelState, setAgentModelOverride } from "../src/registry/agent-models.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pix-registry-models-"));
	roots.push(cwd);
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "reviewer.md"), "---\nmodels: [original/primary, fallback/one]\n---\nReview\n");
	return cwd;
}

test("agent choices persist separately, preserve other names, and reset returns current original", async () => {
	const cwd = fixture();
	const profile = join(cwd, ".pi", "agents", "reviewer.md");
	const original = readFileSync(profile, "utf8");
	const file = join(cwd, ".pi", "agent-model-overrides.json");
	writeFileSync(file, JSON.stringify({ version: 1, models: { other: "other/model" } }));
	await setAgentModelOverride(cwd, "reviewer", "chosen/primary");
	assert.deepEqual({ ...await readAgentModelOverrides(cwd) }, { other: "other/model", reviewer: "chosen/primary" });
	assert.equal(readFileSync(profile, "utf8"), original);
	writeFileSync(profile, original.replace("original/primary", "updated/primary"));
	await setAgentModelOverride(cwd, "reviewer");
	assert.deepEqual({ ...await readAgentModelOverrides(cwd) }, { other: "other/model" });
	assert.deepEqual(await readAgentModelState(profile), { original: "updated/primary", parentAware: false });
});

test("unsafe or malformed project state is refused without overwriting it", async () => {
	const cwd = fixture();
	const file = join(cwd, ".pi", "agent-model-overrides.json");
	for (const raw of ["{", '{"version":2,"models":{}}', '{"version":1,"models":{"reviewer":"pix:auto"}}', " ".repeat(64 * 1024 + 1)]) {
		writeFileSync(file, raw);
		await assert.rejects(setAgentModelOverride(cwd, "reviewer", "chosen/primary"));
		assert.equal(readFileSync(file, "utf8"), raw);
	}
	rmSync(file);
	const target = join(cwd, "outside.json");
	writeFileSync(target, '{"version":1,"models":{}}');
	for (const link of [symlinkSync, linkSync]) {
		link(target, file);
		await assert.rejects(setAgentModelOverride(cwd, "reviewer", "chosen/primary"), /regular project-local file/);
		assert.equal(readFileSync(target, "utf8"), '{"version":1,"models":{}}');
		rmSync(file);
	}
});

test("automatic agents have no model state; parent-aware legacy profiles retain reset metadata", async () => {
	const cwd = fixture();
	const file = join(cwd, ".pi", "agents", "reviewer.md");
	for (const fields of ["description: Automatic", "modelSelection: frontier"]) {
		writeFileSync(file, `---\n${fields}\n---\nReview\n`);
		assert.equal(await readAgentModelState(file), undefined);
		await assert.rejects(setAgentModelOverride(cwd, "reviewer", "chosen/primary"), /explicit model profile/);
	}
	writeFileSync(file, "---\nmodel: original/default\nmodelByParent:\n  parent/*:\n    model: original/parent\n---\nReview\n");
	assert.deepEqual(await readAgentModelState(file), { original: "original/default", parentAware: true });
});
