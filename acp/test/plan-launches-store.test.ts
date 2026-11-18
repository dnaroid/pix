import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
	PIX_PLAN_LAUNCHES_METHOD,
	PLAN_LAUNCH_LIMIT,
	parsePlanLaunchesRequest,
	parsePlanLaunchesResponse,
} from "../src/acp/plan-launches-contract.js";
import { PLAN_LAUNCHES_FILE, createPlanLaunchesStore, isCanonicalPlanLaunchPath } from "../src/acp/plan-launches-store.js";

let cwd: string;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pix-plan-launches-"));
	fs.mkdirSync(path.join(cwd, ".pi/plans"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
});

function readFile(): unknown {
	return JSON.parse(fs.readFileSync(path.join(cwd, PLAN_LAUNCHES_FILE), "utf8"));
}

test("contract validates actions and method name", () => {
	assert.equal(PIX_PLAN_LAUNCHES_METHOD, "pix/plans/launches");
	assert.deepEqual(parsePlanLaunchesRequest({ cwd: "/p", action: "list" }), { cwd: "/p", action: "list" });
	assert.deepEqual(
		parsePlanLaunchesRequest({ cwd: "/p", action: "settle", sessionId: "s", outcome: "failed" }),
		{ cwd: "/p", action: "settle", sessionId: "s", outcome: "failed" },
	);
	assert.throws(() => parsePlanLaunchesRequest({ cwd: "", action: "list" }));
	assert.throws(() => parsePlanLaunchesRequest({ cwd: "/p", action: "drop" }));
	assert.throws(() => parsePlanLaunchesRequest({ cwd: "/p", action: "record", sessionId: "", path: ".pi/plans/a.md" }));
	assert.throws(() => parsePlanLaunchesRequest({ cwd: "/p", action: "settle", sessionId: "s", outcome: "exploded" }));
	assert.throws(() => parsePlanLaunchesResponse({ launches: [] }));
	assert.deepEqual(parsePlanLaunchesResponse({ launches: { s: { path: ".pi/plans/a.md", launchedAt: 1, outcome: "bad", settledAt: 2 } } }), {
		s: { path: ".pi/plans/a.md", launchedAt: 1 },
	});
});

test("canonical plan paths match the Desktop and Registry filter", () => {
	assert.equal(isCanonicalPlanLaunchPath(".pi/plans/a.md"), true);
	assert.equal(isCanonicalPlanLaunchPath(".pi/plans/nested/b.md"), true);
	for (const bad of ["README.md", ".pi/plans/../secret.md", ".pi/plans/.hidden.md", ".pi/plans/tmp/a.md", ".pi/plans/a.txt", ".pi/plans/a.md~"]) {
		assert.equal(isCanonicalPlanLaunchPath(bad), false, bad);
	}
});

test("record, settle and list round-trip through the project file", async () => {
	let t = 0;
	const store = createPlanLaunchesStore({ now: () => ++t });
	assert.deepEqual((await store.handle({ cwd, action: "list" })).launches, {});
	await store.handle({ cwd, action: "record", sessionId: "s1", path: ".pi/plans/x.md" });
	// Unknown sessions are ignored without writing a status.
	await store.handle({ cwd, action: "settle", sessionId: "ordinary", outcome: "failed" });
	const settled = await store.handle({ cwd, action: "settle", sessionId: "s1", outcome: "cancelled" });
	assert.deepEqual(settled.launches, { s1: { path: ".pi/plans/x.md", launchedAt: 1, outcome: "cancelled", settledAt: 2 } });
	assert.deepEqual(readFile(), settled.launches);
	// A fresh store (another process) reads the same state.
	assert.deepEqual((await createPlanLaunchesStore().handle({ cwd, action: "list" })).launches, settled.launches);
	await assert.rejects(store.handle({ cwd, action: "record", sessionId: "s2", path: "README.md" }), /Not a saved plan path/);
});

test("concurrent mutations of one project are serialized without lost updates", async () => {
	let t = 0;
	const store = createPlanLaunchesStore({ now: () => ++t });
	await Promise.all(Array.from({ length: 20 }, (_, index) =>
		store.handle({ cwd, action: "record", sessionId: `s${index}`, path: ".pi/plans/x.md" })));
	const { launches } = await store.handle({ cwd, action: "list" });
	assert.equal(Object.keys(launches).length, 20);
	assert.deepEqual(fs.readdirSync(path.join(cwd, ".pi")).filter((name) => name.endsWith(".tmp")), []);
});

test("import migrates legacy records once; existing entries win and the result is bounded", async () => {
	let t = 1_000;
	const store = createPlanLaunchesStore({ now: () => ++t });
	await store.handle({ cwd, action: "record", sessionId: "s1", path: ".pi/plans/x.md" });
	const legacy = {
		s1: { path: ".pi/plans/old.md", launchedAt: 1 },
		s2: { path: ".pi/plans/y.md", launchedAt: 2, outcome: "completed", settledAt: 3 },
		escape: { path: ".pi/plans/../secret.md", launchedAt: 4 },
	};
	const imported = await store.handle({ cwd, action: "import", launches: legacy });
	assert.deepEqual(imported.launches, {
		s1: { path: ".pi/plans/x.md", launchedAt: 1_001 },
		s2: { path: ".pi/plans/y.md", launchedAt: 2, outcome: "completed", settledAt: 3 },
	});
	const many = Object.fromEntries(Array.from({ length: PLAN_LAUNCH_LIMIT + 10 }, (_, index) =>
		[`old${index}`, { path: ".pi/plans/z.md", launchedAt: index }]));
	const bounded = await store.handle({ cwd, action: "import", launches: many });
	assert.equal(Object.keys(bounded.launches).length, PLAN_LAUNCH_LIMIT);
	assert.ok(bounded.launches.s1, "newest local launch is retained");
});

test("a corrupt file reads as empty and is replaced by the next write", async () => {
	fs.writeFileSync(path.join(cwd, PLAN_LAUNCHES_FILE), "{not json");
	const store = createPlanLaunchesStore({ now: () => 5 });
	assert.deepEqual((await store.handle({ cwd, action: "list" })).launches, {});
	await store.handle({ cwd, action: "record", sessionId: "s1", path: ".pi/plans/x.md" });
	assert.deepEqual(readFile(), { s1: { path: ".pi/plans/x.md", launchedAt: 5 } });
});
