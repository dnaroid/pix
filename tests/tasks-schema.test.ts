import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { ProjectTasksSchema } from "../src/schemas/tasks-schema.js";
import { TASK_STATUSES } from "../external/pi-tools-suite/src/project-tasks/schema.js";

test("task status schema supports failed and keeps agent enums aligned", () => {
	const status = ProjectTasksSchema.properties.tasks.items.properties.status;
	assert.deepEqual(status.anyOf.map(item => item.const), [...TASK_STATUSES]);
	for (const value of TASK_STATUSES) assert.equal(Value.Check(status, value), true);
	assert.equal(Value.Check(status, "failure"), false);
	assert.equal(ProjectTasksSchema.properties.version.const, 1);
});

test("generated task schema matches the authoritative source", () => {
	const generated = JSON.parse(readFileSync(new URL("../schemas/tasks.json", import.meta.url), "utf8"));
	assert.deepEqual(generated, JSON.parse(JSON.stringify(ProjectTasksSchema)));
});
