import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "jsonc-parser";

import {
	applyModelRolesToPixConfig,
	applyModelRolesToSuiteConfig,
	suggestModelRoles,
} from "../src/setup/model-profile.js";

const models = [
	{ provider: "p1", id: "alpha-flash" },
	{ provider: "p1", id: "alpha" },
	{ provider: "p1", id: "alpha-pro" },
];

test("suggests roles from name hints when cost is unknown", () => {
	assert.deepEqual(suggestModelRoles(models), {
		main: "p1/alpha",
		fast: "p1/alpha-flash",
		strong: "p1/alpha-pro",
	});
});

test("single model fills every role; empty yields undefined", () => {
	const roles = suggestModelRoles([{ provider: "x", id: "only" }]);
	assert.deepEqual(roles, { main: "x/only", fast: "x/only", strong: "x/only" });
	assert.equal(suggestModelRoles([]), undefined);
});

test("pix config writer sets roles and keeps comments", () => {
	const roles = { main: "p/m", fast: "p/f", strong: "p/s" };
	const out = applyModelRolesToPixConfig("{\n  // keep me\n  \"ignoreContextFiles\": false\n}\n", roles);
	assert.match(out, /keep me/);
	const parsed = parse(out);
	assert.equal(parsed.defaultModel.modelRef, "p/m");
	assert.equal(parsed.autocomplete.modelRef, "p/f");
	assert.equal(parsed.desktop.git.reviewModelRef, "p/s:medium");
});

test("suite writer sets frontier model", () => {
	const out = applyModelRolesToSuiteConfig("", { main: "a/b", fast: "a/c", strong: "a/d" });
	assert.deepEqual(parse(out).frontierModels, [{ model: "a/d" }]);
	assert.equal(parse(out).builtinAgentModels.research, "a/c");
	assert.equal(parse(out).builtinAgentModels["implement-core"], "a/b");
});
